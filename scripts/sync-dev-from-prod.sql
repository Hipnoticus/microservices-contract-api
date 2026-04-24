-- Sync dev database from production via OPENROWSET
-- Run on localhost (dev) MSSQL as sa

DECLARE @prodConn NVARCHAR(500) = 'Server=mssql2.hipnoterapia.org;Database=Hipnoticus;UID=hipnoticus;PWD=hipno8991;TrustServerCertificate=Yes;';
DECLARE @sql NVARCHAR(MAX);
DECLARE @tbl NVARCHAR(128);
DECLARE @cols NVARCHAR(MAX);
DECLARE @hasIdentity BIT;

-- Cursor through all tb* tables
DECLARE tbl_cursor CURSOR FOR
SELECT t.name FROM sys.tables t WHERE t.name LIKE 'tb%' ORDER BY t.name;

OPEN tbl_cursor;
FETCH NEXT FROM tbl_cursor INTO @tbl;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Get column names
    SELECT @cols = STRING_AGG(QUOTENAME(c.name), ', ')
    FROM sys.columns c WHERE c.object_id = OBJECT_ID(@tbl);

    -- Check if has IDENTITY
    SELECT @hasIdentity = CASE WHEN EXISTS(
        SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id
        WHERE t.name=@tbl AND c.name='ID' AND c.is_identity=1
    ) THEN 1 ELSE 0 END;

    -- Delete existing dev data
    SET @sql = 'DELETE FROM ' + QUOTENAME(@tbl);
    EXEC sp_executesql @sql;

    -- Build INSERT from OPENROWSET
    IF @hasIdentity = 1
        SET @sql = 'SET IDENTITY_INSERT ' + QUOTENAME(@tbl) + ' ON; ';
    ELSE
        SET @sql = '';

    SET @sql = @sql + 'INSERT INTO ' + QUOTENAME(@tbl) + ' (' + @cols + ') SELECT ' + @cols +
        ' FROM OPENROWSET(''MSOLEDBSQL'', ''' + @prodConn + ''', ''SELECT * FROM ' + @tbl + ''')';

    IF @hasIdentity = 1
        SET @sql = @sql + '; SET IDENTITY_INSERT ' + QUOTENAME(@tbl) + ' OFF';

    BEGIN TRY
        EXEC sp_executesql @sql;
        PRINT @tbl + ': synced';
    END TRY
    BEGIN CATCH
        PRINT @tbl + ': ERROR - ' + ERROR_MESSAGE();
    END CATCH

    FETCH NEXT FROM tbl_cursor INTO @tbl;
END

CLOSE tbl_cursor;
DEALLOCATE tbl_cursor;

PRINT '=== Sync complete ===';
