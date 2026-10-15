-- Google Calendar one-way sync (Hipnoticus -> Google) schema.
-- Idempotent: safe to run more than once. Run on DEV first, then on PROD after approval.
--   tbSessions.TherapistUserID   which tbUsers therapist owns the session (backfilled to 1 = henrique)
--   tbGoogleCalendarAccounts     connected Google accounts per tbUsers user (refresh token AES-256-GCM encrypted)
--   tbGoogleCalendarEvents       (AccountID, SessionID) -> Google event id + payload hash
--   tbGoogleCalendarTickets      single-use 5-minute admin tickets minted by ControleWeb
SET NOCOUNT ON;

IF COL_LENGTH('tbSessions', 'TherapistUserID') IS NULL
BEGIN
    ALTER TABLE tbSessions ADD TherapistUserID INT NOT NULL
        CONSTRAINT DF_tbSessions_TherapistUserID DEFAULT 1 WITH VALUES;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_tbSessions_TherapistUser')
    ALTER TABLE tbSessions ADD CONSTRAINT FK_tbSessions_TherapistUser
        FOREIGN KEY (TherapistUserID) REFERENCES tbUsers(ID);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tbSessions_Therapist_DateBegins' AND object_id = OBJECT_ID('tbSessions'))
    CREATE INDEX IX_tbSessions_Therapist_DateBegins ON tbSessions (TherapistUserID, DateBegins);
GO

IF OBJECT_ID('tbGoogleCalendarAccounts', 'U') IS NULL
BEGIN
    CREATE TABLE tbGoogleCalendarAccounts (
        ID              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_tbGoogleCalendarAccounts PRIMARY KEY,
        UserID          INT NOT NULL CONSTRAINT FK_tbGoogleCalendarAccounts_User REFERENCES tbUsers(ID),
        GoogleEmail     VARCHAR(255) NOT NULL,
        RefreshTokenEnc VARCHAR(2048) NOT NULL,
        CalendarID      VARCHAR(255) NULL,
        Status          VARCHAR(20) NOT NULL CONSTRAINT DF_tbGoogleCalendarAccounts_Status DEFAULT 'active',
        LastSyncAt      DATETIME NULL,
        LastError       NVARCHAR(1000) NULL,
        Blocked         BIT NOT NULL CONSTRAINT DF_tbGoogleCalendarAccounts_Blocked DEFAULT 0,
        DateCreated     DATETIME NOT NULL CONSTRAINT DF_tbGoogleCalendarAccounts_DateCreated DEFAULT GETDATE(),
        DateModified    DATETIME NULL,
        CreatedBy       INT NULL,
        ModifiedBy      INT NULL,
        CONSTRAINT UQ_tbGoogleCalendarAccounts_User_Email UNIQUE (UserID, GoogleEmail),
        CONSTRAINT CK_tbGoogleCalendarAccounts_Status CHECK (Status IN ('active', 'error', 'revoked'))
    );
END
GO

IF OBJECT_ID('tbGoogleCalendarEvents', 'U') IS NULL
BEGIN
    -- SessionID deliberately has no FK: sessions are hard-deleted and the orphan mapping is how a deletion is detected.
    CREATE TABLE tbGoogleCalendarEvents (
        ID            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_tbGoogleCalendarEvents PRIMARY KEY,
        AccountID     INT NOT NULL CONSTRAINT FK_tbGoogleCalendarEvents_Account
                          REFERENCES tbGoogleCalendarAccounts(ID) ON DELETE CASCADE,
        SessionID     INT NOT NULL,
        GoogleEventID VARCHAR(255) NOT NULL,
        PayloadHash   CHAR(64) NOT NULL,
        DateCreated   DATETIME NOT NULL CONSTRAINT DF_tbGoogleCalendarEvents_DateCreated DEFAULT GETDATE(),
        DateModified  DATETIME NULL,
        CONSTRAINT UQ_tbGoogleCalendarEvents_Account_Session UNIQUE (AccountID, SessionID)
    );
END
GO

IF OBJECT_ID('tbGoogleCalendarTickets', 'U') IS NULL
BEGIN
    CREATE TABLE tbGoogleCalendarTickets (
        ID          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_tbGoogleCalendarTickets PRIMARY KEY,
        Token       CHAR(64) NOT NULL CONSTRAINT UQ_tbGoogleCalendarTickets_Token UNIQUE,
        UserID      INT NOT NULL CONSTRAINT FK_tbGoogleCalendarTickets_User REFERENCES tbUsers(ID),
        ExpiresAt   DATETIME NOT NULL,
        UsedAt      DATETIME NULL,
        DateCreated DATETIME NOT NULL CONSTRAINT DF_tbGoogleCalendarTickets_DateCreated DEFAULT GETDATE()
    );
END
GO
