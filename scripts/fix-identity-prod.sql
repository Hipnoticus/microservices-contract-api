-- Fix IDENTITY on production tables
-- Each block: create _new with IDENTITY, copy, drop old, rename

-- ═══ tbPayments (empty, simple) ═══
IF NOT EXISTS (SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id WHERE t.name='tbPayments' AND c.name='ID' AND c.is_identity=1)
BEGIN
    SELECT * INTO tbPayments_bak FROM tbPayments WHERE 1=0;
    INSERT INTO tbPayments_bak SELECT * FROM tbPayments;
    DROP TABLE tbPayments;
    CREATE TABLE tbPayments (ID INT IDENTITY(1,1) NOT NULL, OrderID INT NULL, PaymentMethodID INT NULL, Amount DECIMAL(18,2) NULL, Status INT NULL, TransactionID NVARCHAR(100) NULL, AuthorizationCode NVARCHAR(50) NULL, DateCreated DATETIME DEFAULT GETDATE(), DateModified DATETIME DEFAULT GETDATE());
    PRINT 'tbPayments: IDENTITY added';
    DROP TABLE tbPayments_bak;
END
GO

-- ═══ tbLeads (empty or near-empty) ═══
IF NOT EXISTS (SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id WHERE t.name='tbLeads' AND c.name='ID' AND c.is_identity=1)
BEGIN
    DECLARE @cols_leads NVARCHAR(MAX);
    SELECT @cols_leads = STRING_AGG(QUOTENAME(c.name), ', ') FROM sys.columns c WHERE c.object_id = OBJECT_ID('tbLeads') AND c.name != 'ID';
    
    DECLARE @coldefs_leads NVARCHAR(MAX);
    SELECT @coldefs_leads = STRING_AGG(
        QUOTENAME(c.name) + ' ' + ty.name +
        CASE WHEN ty.name IN ('nvarchar','varchar') THEN '(' + CASE WHEN c.max_length=-1 THEN 'MAX' ELSE CAST(c.max_length/CASE WHEN ty.name LIKE 'n%' THEN 2 ELSE 1 END AS VARCHAR) END + ')' ELSE '' END +
        CASE WHEN c.is_nullable=1 THEN ' NULL' ELSE ' NOT NULL' END, ', ')
    FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id
    WHERE c.object_id = OBJECT_ID('tbLeads') AND c.name != 'ID';
    
    EXEC('CREATE TABLE tbLeads_new (ID INT IDENTITY(1,1) NOT NULL, ' + @coldefs_leads + ')');
    EXEC('SET IDENTITY_INSERT tbLeads_new ON; INSERT INTO tbLeads_new (ID, ' + @cols_leads + ') SELECT ID, ' + @cols_leads + ' FROM tbLeads; SET IDENTITY_INSERT tbLeads_new OFF');
    DROP TABLE tbLeads;
    EXEC sp_rename 'tbLeads_new', 'tbLeads';
    PRINT 'tbLeads: IDENTITY added';
END
GO
