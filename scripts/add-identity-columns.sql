-- Add IDENTITY to ID columns on production tables
-- Safe: creates temp table, copies data, swaps
-- Run on mssql2.hipnoterapia.org / Hipnoticus

-- Helper procedure to add IDENTITY to any table
-- Usage: EXEC #AddIdentity 'tbCustomers', 6600
IF OBJECT_ID('tempdb..#AddIdentity') IS NOT NULL DROP PROCEDURE #AddIdentity;
GO

CREATE PROCEDURE #AddIdentity @tableName NVARCHAR(128), @seed INT
AS
BEGIN
    DECLARE @sql NVARCHAR(MAX);
    DECLARE @cols NVARCHAR(MAX);
    DECLARE @colsNoId NVARCHAR(MAX);

    -- Check if already has IDENTITY
    IF EXISTS (SELECT 1 FROM sys.tables t JOIN sys.columns c ON t.object_id = c.object_id WHERE t.name = @tableName AND c.name = 'ID' AND c.is_identity = 1)
    BEGIN
        PRINT @tableName + ': already has IDENTITY, skipping';
        RETURN;
    END

    -- Get all column definitions except ID
    SELECT @cols = STRING_AGG(
        QUOTENAME(c.name) + ' ' + ty.name +
        CASE WHEN ty.name IN ('nvarchar','varchar','nchar','char') THEN '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(c.max_length / CASE WHEN ty.name LIKE 'n%' THEN 2 ELSE 1 END AS VARCHAR) END + ')' 
             WHEN ty.name IN ('decimal','numeric') THEN '(' + CAST(c.precision AS VARCHAR) + ',' + CAST(c.scale AS VARCHAR) + ')'
             ELSE '' END +
        CASE WHEN c.is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END,
        ', '
    )
    FROM sys.columns c
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE c.object_id = OBJECT_ID(@tableName) AND c.name != 'ID';

    -- Get column names for INSERT
    SELECT @colsNoId = STRING_AGG(QUOTENAME(c.name), ', ')
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID(@tableName) AND c.name != 'ID';

    -- Create temp table with IDENTITY
    SET @sql = 'CREATE TABLE ' + QUOTENAME(@tableName + '_new') + ' (ID INT IDENTITY(' + CAST(@seed AS VARCHAR) + ',1) NOT NULL, ' + @cols + ')';
    EXEC sp_executesql @sql;

    -- Copy data with IDENTITY_INSERT
    SET @sql = 'SET IDENTITY_INSERT ' + QUOTENAME(@tableName + '_new') + ' ON; ' +
               'INSERT INTO ' + QUOTENAME(@tableName + '_new') + ' (ID, ' + @colsNoId + ') SELECT ID, ' + @colsNoId + ' FROM ' + QUOTENAME(@tableName) + '; ' +
               'SET IDENTITY_INSERT ' + QUOTENAME(@tableName + '_new') + ' OFF';
    EXEC sp_executesql @sql;

    -- Swap tables
    SET @sql = 'DROP TABLE ' + QUOTENAME(@tableName);
    EXEC sp_executesql @sql;

    SET @sql = 'EXEC sp_rename ' + QUOTENAME(@tableName + '_new', '''') + ', ' + QUOTENAME(@tableName, '''');
    EXEC sp_executesql @sql;

    PRINT @tableName + ': IDENTITY added (seed=' + CAST(@seed AS VARCHAR) + ')';
END
GO
