-- Charges ContractAPI makes for other applications (/payments/external/**), first Hipno Online's boletos.
-- One row per (Origin, ExternalRef, Method): a retry of the same order returns the same boleto.
-- Idempotent. Dev: run as sa on hipnoticus-mssql. Production: run as the owner, then the GRANT below.
-- .plans/HIPNOONLINE_CONTRACTAPI_PAYMENTS_PLAN.md
IF OBJECT_ID('dbo.tbExternalCharges', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tbExternalCharges (
    ID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_tbExternalCharges PRIMARY KEY,
    Origin varchar(40) NOT NULL,          -- caller name: hipno-online, amode
    ExternalRef varchar(40) NOT NULL,     -- the caller's order reference (Magento order number)
    Method varchar(20) NOT NULL,          -- boleto, pix, pix_automatico
    Provider varchar(20) NOT NULL,        -- inter
    ProviderRef varchar(80) NULL,         -- Inter codigoSolicitacao / txid / idRec, Cielo PaymentId
    CardToken varchar(100) NULL,          -- Cielo CardToken, as Cielo provides it (saved cards only)
    SeuNumero varchar(15) NULL,           -- origin code + reference (HO7899464258)
    Amount decimal(12,2) NOT NULL,
    Status varchar(30) NOT NULL,          -- PENDING, FAILED, then Inter's situacao (A_RECEBER, RECEBIDO, ...)
    PaidAt datetime2(0) NULL,
    DateCreated datetime2(0) NOT NULL CONSTRAINT DF_tbExternalCharges_DateCreated DEFAULT SYSDATETIME(),
    DateModified datetime2(0) NOT NULL CONSTRAINT DF_tbExternalCharges_DateModified DEFAULT SYSDATETIME(),
    CreatedBy varchar(60) NOT NULL CONSTRAINT DF_tbExternalCharges_CreatedBy DEFAULT 'contract-api',
    ModifiedBy varchar(60) NOT NULL CONSTRAINT DF_tbExternalCharges_ModifiedBy DEFAULT 'contract-api',
    Blocked bit NOT NULL CONSTRAINT DF_tbExternalCharges_Blocked DEFAULT 0
  );
  CREATE UNIQUE INDEX UX_tbExternalCharges_Ref ON dbo.tbExternalCharges (Origin, ExternalRef, Method);
  CREATE INDEX IX_tbExternalCharges_ProviderRef ON dbo.tbExternalCharges (ProviderRef);
END
GO
-- Added the same day: Cielo's card token for saved cards.
IF COL_LENGTH('dbo.tbExternalCharges', 'CardToken') IS NULL
  ALTER TABLE dbo.tbExternalCharges ADD CardToken varchar(100) NULL;
GO
-- ContractAPI's own login only (tools/incident-20261123/service-tables.json).
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'svc_contract')
  GRANT SELECT, INSERT, UPDATE ON dbo.tbExternalCharges TO svc_contract;
GO
