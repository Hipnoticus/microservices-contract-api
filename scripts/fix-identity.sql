-- Generic procedure to add IDENTITY to a table's ID column
CREATE OR ALTER PROCEDURE sp_AddIdentityToTable @tbl NVARCHAR(128)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cols NVARCHAR(MAX), @coldefs NVARCHAR(MAX), @maxid INT, @sql NVARCHAR(MAX);

    -- Skip if already has IDENTITY
    IF EXISTS (SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id 
               WHERE t.name=@tbl AND c.name='ID' AND c.is_identity=1)
    BEGIN
        PRINT @tbl + ' already has IDENTITY';
        RETURN;
    END

    -- Get max ID for seed
    SET @sql = N'SELECT @m=ISNULL(MAX(ID),0)+1 FROM ' + QUOTENAME(@tbl);
    EXEC sp_executesql @sql, N'@m INT OUTPUT', @m=@maxid OUTPUT;

    -- Get column names (excluding ID)
    SELECT @cols = STRING_AGG(QUOTENAME(c.name), ', ')
    FROM sys.columns c WHERE c.object_id=OBJECT_ID(@tbl) AND c.name!='ID';

    -- Get column definitions (excluding ID)
    SELECT @coldefs = STRING_AGG(
        QUOTENAME(c.name) + ' ' + ty.name +
        CASE 
            WHEN ty.name IN ('nvarchar','varchar','nchar','char','varbinary') 
                THEN '(' + CASE WHEN c.max_length=-1 THEN 'MAX' 
                     ELSE CAST(c.max_length / CASE WHEN ty.name LIKE 'n%' THEN 2 ELSE 1 END AS VARCHAR) END + ')'
            WHEN ty.name IN ('decimal','numeric') 
                THEN '(' + CAST(c.precision AS VARCHAR) + ',' + CAST(c.scale AS VARCHAR) + ')'
            ELSE '' 
        END +
        CASE WHEN c.is_nullable=1 THEN ' NULL' ELSE ' NOT NULL' END,
        ', '
    )
    FROM sys.columns c 
    JOIN sys.types ty ON c.user_type_id=ty.user_type_id
    WHERE c.object_id=OBJECT_ID(@tbl) AND c.name!='ID';

    -- Create new table with IDENTITY
    SET @sql = 'CREATE TABLE ' + QUOTENAME(@tbl + '_new') + ' (ID INT IDENTITY(' + CAST(@maxid AS VARCHAR) + ',1) NOT NULL, ' + @coldefs + ')';
    EXEC sp_executesql @sql;

    -- Copy data
    SET @sql = 'SET IDENTITY_INSERT ' + QUOTENAME(@tbl + '_new') + ' ON; ' +
               'INSERT INTO ' + QUOTENAME(@tbl + '_new') + ' (ID, ' + @cols + ') SELECT ID, ' + @cols + ' FROM ' + QUOTENAME(@tbl) + '; ' +
               'SET IDENTITY_INSERT ' + QUOTENAME(@tbl + '_new') + ' OFF';
    EXEC sp_executesql @sql;

    -- Swap: drop old, rename new
    SET @sql = 'DROP TABLE ' + QUOTENAME(@tbl);
    EXEC sp_executesql @sql;

    DECLARE @newname NVARCHAR(256) = @tbl + '_new';
    EXEC sp_rename @newname, @tbl;

    PRINT @tbl + ' IDENTITY added (seed=' + CAST(@maxid AS VARCHAR) + ')';
END
GO

-- Run for all tables
EXEC sp_AddIdentityToTable 'tbPayments';
EXEC sp_AddIdentityToTable 'tbLeads';
EXEC sp_AddIdentityToTable 'tbProducts';
EXEC sp_AddIdentityToTable 'tbFormasPagamento';
EXEC sp_AddIdentityToTable 'tbModules';
EXEC sp_AddIdentityToTable 'tbQuestionnaires';
EXEC sp_AddIdentityToTable 'tbQuestionnairesQuestions';
EXEC sp_AddIdentityToTable 'tbQuestionnairesAnswersRecords';
EXEC sp_AddIdentityToTable 'tbQuestionnairesRequests';
EXEC sp_AddIdentityToTable 'tbIssues';
EXEC sp_AddIdentityToTable 'tbSiteContacts';
EXEC sp_AddIdentityToTable 'tbCustomers';
EXEC sp_AddIdentityToTable 'tbCustomersAddresses';
EXEC sp_AddIdentityToTable 'tbOrders';
EXEC sp_AddIdentityToTable 'tbOrdersProducts';
EXEC sp_AddIdentityToTable 'tbSessions';
EXEC sp_AddIdentityToTable 'tbSchedule';
EXEC sp_AddIdentityToTable 'tbTreatments';
GO

-- Cleanup
DROP PROCEDURE sp_AddIdentityToTable;
GO

PRINT '=== All tables processed ===';
GO
