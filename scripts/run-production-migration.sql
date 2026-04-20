-- Production Migration — April 20, 2026
-- Run against mssql2.hipnoterapia.org / Hipnoticus
-- All statements are idempotent

-- ═══════════════════════════════════════════════════════════════
-- 1. QAQS Questionnaire (Qualidade do Sono) — ID 9
-- ═══════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM tbQuestionnaires WHERE ShortName = 'QAQS')
BEGIN
    SET IDENTITY_INSERT tbQuestionnaires ON
    INSERT INTO tbQuestionnaires (ID, Name, ShortName, Description, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
    VALUES (9, N'Questionário de Análise de Qualidade do Sono', 'QAQS', N'Nas perguntas abaixo, responda apenas Sim ou Não.', 0, GETDATE(), GETDATE(), 1, 1)
    SET IDENTITY_INSERT tbQuestionnaires OFF
    PRINT 'QAQS questionnaire created'
END
GO

IF NOT EXISTS (SELECT 1 FROM tbQuestionnairesQuestions WHERE Questionnaire = 9)
BEGIN
    SET IDENTITY_INSERT tbQuestionnairesQuestions ON
    INSERT INTO tbQuestionnairesQuestions (ID, Question, Questionnaire, PriorityOrder, AnswerType, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy) VALUES
    (217, N'Você tem facilidade para adormecer (pegar no sono) na hora que precisa ou deseja?', 9, 1, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (218, N'Você tem um sono reparador (acorda descansado)?', 9, 2, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (219, N'Você acorda disposto, energizado e motivado para viver o seu dia?', 9, 3, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (220, N'Você sonha?', 9, 4, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (221, N'Você lembra dos seus sonhos?', 9, 5, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (222, N'Você lembra dos seus sonhos ao acordar?', 9, 6, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (223, N'Você lembra dos seus sonhos durante o dia?', 9, 7, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (224, N'Você lembra dos seus sonhos dias depois do mesmo ter ocorrido?', 9, 8, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (225, N'Você dorme sempre no mesmo horário?', 9, 9, 1, 0, GETDATE(), GETDATE(), 1, 1),
    (226, N'Você dorme em horários muito diferentes?', 9, 10, 1, 0, GETDATE(), GETDATE(), 1, 1)
    SET IDENTITY_INSERT tbQuestionnairesQuestions OFF
    PRINT 'QAQS questions created'
END
GO

-- ═══════════════════════════════════════════════════════════════
-- 2. Customer Cards (Cielo tokenization)
-- ═══════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tbCustomerCards')
BEGIN
    CREATE TABLE tbCustomerCards (
        ID INT IDENTITY(1,1) PRIMARY KEY,
        CustomerID INT NOT NULL,
        CardToken NVARCHAR(100) NOT NULL,
        Brand NVARCHAR(20) NOT NULL,
        LastFourDigits NVARCHAR(4) NOT NULL,
        HolderName NVARCHAR(100) NOT NULL,
        ExpirationDate NVARCHAR(7) NOT NULL,
        IsDefault BIT DEFAULT 0,
        Alias NVARCHAR(50) NULL,
        Blocked BIT DEFAULT 0,
        DateCreated DATETIME DEFAULT GETDATE(),
        DateModified DATETIME DEFAULT GETDATE(),
        CONSTRAINT FK_CustomerCards_Customer FOREIGN KEY (CustomerID) REFERENCES tbCustomers(ID)
    )
    CREATE INDEX IX_CustomerCards_CustomerID ON tbCustomerCards(CustomerID)
    PRINT 'tbCustomerCards created'
END
GO

-- ═══════════════════════════════════════════════════════════════
-- 3. NFS-e tables
-- ═══════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tbNFSe')
BEGIN
    CREATE TABLE tbNFSe (
        ID INT IDENTITY(1,1) PRIMARY KEY,
        Number NVARCHAR(20) NULL,
        VerificationCode NVARCHAR(50) NULL,
        OrderID INT NULL,
        SessionID INT NULL,
        CustomerID INT NOT NULL,
        CNPJ NVARCHAR(14) NOT NULL DEFAULT '12344385000193',
        InscricaoMunicipal NVARCHAR(20) NULL,
        ServiceCode NVARCHAR(10) NOT NULL DEFAULT '8690-9/99',
        ServiceDescription NVARCHAR(500) NOT NULL DEFAULT N'Serviços de hipnoterapia clínica',
        Value DECIMAL(18,2) NOT NULL,
        ISSRate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
        ISSValue DECIMAL(18,2) NULL,
        TomadorCPFCNPJ NVARCHAR(14) NOT NULL,
        TomadorName NVARCHAR(200) NOT NULL,
        TomadorEmail NVARCHAR(200) NULL,
        Status INT NOT NULL DEFAULT 1,
        StatusMessage NVARCHAR(500) NULL,
        Protocol NVARCHAR(50) NULL,
        XMLRequest TEXT NULL,
        XMLResponse TEXT NULL,
        PDFUrl NVARCHAR(500) NULL,
        Name NVARCHAR(200) NULL,
        Description NVARCHAR(500) NULL,
        Blocked BIT DEFAULT 0,
        DateCreated DATETIME DEFAULT GETDATE(),
        DateModified DATETIME DEFAULT GETDATE(),
        DateIssued DATETIME NULL,
        DateCanceled DATETIME NULL,
        CreatedBy INT DEFAULT 1,
        ModifiedBy INT DEFAULT 1,
        CONSTRAINT FK_NFSe_Customer FOREIGN KEY (CustomerID) REFERENCES tbCustomers(ID)
    )
    CREATE INDEX IX_NFSe_CustomerID ON tbNFSe(CustomerID)
    CREATE INDEX IX_NFSe_OrderID ON tbNFSe(OrderID)
    PRINT 'tbNFSe created'
END
GO

IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tbNFSeConfig')
BEGIN
    CREATE TABLE tbNFSeConfig (
        ID INT IDENTITY(1,1) PRIMARY KEY,
        ConfigKey NVARCHAR(100) NOT NULL UNIQUE,
        ConfigValue NVARCHAR(1000) NOT NULL,
        Description NVARCHAR(500) NULL,
        DateModified DATETIME DEFAULT GETDATE()
    )
    INSERT INTO tbNFSeConfig (ConfigKey, ConfigValue, Description) VALUES
    ('CNPJ', '12344385000193', N'CNPJ do prestador'),
    ('InscricaoMunicipal', '', N'Inscrição Municipal'),
    ('RazaoSocial', 'HIPNOTICUS TERAPIA LTDA', N'Razão Social'),
    ('NomeFantasia', 'Hipnoticus', N'Nome Fantasia'),
    ('CodigoMunicipio', '5300108', N'Código IBGE (Brasília)'),
    ('UF', 'DF', 'UF'),
    ('ServiceCode', '8690-9/99', 'CNAE'),
    ('ServiceDescription', N'Serviços de hipnoterapia clínica', N'Descrição padrão'),
    ('ISSRate', '5.00', N'Alíquota ISS (%)'),
    ('Environment', 'homologacao', N'homologacao ou producao'),
    ('CertificatePath', '', N'Caminho do e-CNPJ (.pfx)'),
    ('CertificatePassword', '', N'Senha do certificado'),
    ('AutoIssue', 'false', N'Emissão automática')
    PRINT 'tbNFSeConfig created'
END
GO

-- ═══════════════════════════════════════════════════════════════
-- 4. NFS-e module in ControleWeb
-- ═══════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM tbmodules WHERE FilePrefix = 'nfse')
BEGIN
    INSERT INTO tbmodules (Name, Description, Icon, FolderName, FilePrefix, TableName, Blocked,
        FieldsToCatch, FieldsToGroup,
        DateCreated, DateModified, CreatedBy, ModifiedBy)
    VALUES (N'NFS-e', N'Notas Fiscais de Serviço Eletrônicas', 'Write Document.png', 'nfse', 'nfse', 'tbNFSe', 0,
        'ID, Name, Description, '''' as Icon, DateCreated',
        'ID, Name, Description, DateCreated',
        GETDATE(), GETDATE(), 1, 1)
    PRINT 'NFS-e module registered'
END
GO

-- ═══════════════════════════════════════════════════════════════
-- 5. Leads table — add missing columns to existing table
-- ═══════════════════════════════════════════════════════════════
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'Name')
    ALTER TABLE tbLeads ADD Name NVARCHAR(200) NULL
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'Email')
    ALTER TABLE tbLeads ADD Email NVARCHAR(200) NULL
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'Phone')
    ALTER TABLE tbLeads ADD Phone NVARCHAR(50) NULL
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'CPF')
    ALTER TABLE tbLeads ADD CPF NVARCHAR(14) NULL
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'PackageName')
    ALTER TABLE tbLeads ADD PackageName NVARCHAR(200) NULL
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbLeads' AND COLUMN_NAME = 'Source')
    ALTER TABLE tbLeads ADD Source NVARCHAR(50) NULL
GO
IF NOT EXISTS (SELECT name FROM sys.indexes WHERE name = 'IX_Leads_Email' AND object_id = OBJECT_ID('tbLeads'))
    CREATE INDEX IX_Leads_Email ON tbLeads(Email)
GO

-- ═══════════════════════════════════════════════════════════════
-- 6. Clean up test sessions
-- ═══════════════════════════════════════════════════════════════
DELETE FROM tbSessions WHERE ID IN (3560, 3561, 3562, 3563) AND ClientID = 43
DELETE FROM tbSchedule WHERE ClientID = 43 AND YEAR(DateBegins) = 2024 AND ID > 164
GO

PRINT '=== Production migration complete ==='
GO
