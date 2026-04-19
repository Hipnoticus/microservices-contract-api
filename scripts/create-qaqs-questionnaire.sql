-- Questionário de Análise de Qualidade do Sono (QAQS)
-- Run this on PRODUCTION database (mssql2.hipnoterapia.org)
-- Already applied to DEV database

-- Check if already exists
IF NOT EXISTS (SELECT 1 FROM tbQuestionnaires WHERE ShortName = 'QAQS')
BEGIN
    SET IDENTITY_INSERT tbQuestionnaires ON;
    INSERT INTO tbQuestionnaires (ID, Name, ShortName, Description, Blocked, DateCreated, DateModified, CreatedBy, ModifiedBy)
    VALUES (9, N'Questionário de Análise de Qualidade do Sono', 'QAQS', N'Nas perguntas abaixo, responda apenas Sim ou Não.', 0, GETDATE(), GETDATE(), 1, 1);
    SET IDENTITY_INSERT tbQuestionnaires OFF;
    PRINT 'Questionnaire QAQS created (ID 9)';
END
ELSE
    PRINT 'Questionnaire QAQS already exists';

-- Questions
IF NOT EXISTS (SELECT 1 FROM tbQuestionnairesQuestions WHERE Questionnaire = 9)
BEGIN
    SET IDENTITY_INSERT tbQuestionnairesQuestions ON;
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
    (226, N'Você dorme em horários muito diferentes?', 9, 10, 1, 0, GETDATE(), GETDATE(), 1, 1);
    SET IDENTITY_INSERT tbQuestionnairesQuestions OFF;
    PRINT '10 questions created';
END
ELSE
    PRINT 'Questions already exist for QAQS';

-- Request for customer 43 (Gabriel Veloso)
INSERT INTO tbQuestionnairesRequests (Hash, ClientID, Treatment, Questionnaire, Status, DateCreated, DateModified)
VALUES (NEWID(), 43, 2, 9, 1, GETDATE(), GETDATE());
PRINT 'Request created for customer 43';
