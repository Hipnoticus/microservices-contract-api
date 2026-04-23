$server = "mssql2.hipnoterapia.org"
$user = "hipnoticus"
$pass = "hipno8991"

$tables = @(
    "tbPayments","tbLeads","tbProducts","tbFormasPagamento","tbModules",
    "tbQuestionnaires","tbQuestionnairesQuestions","tbQuestionnairesAnswersRecords",
    "tbQuestionnairesRequests","tbIssues","tbSiteContacts",
    "tbCustomers","tbCustomersAddresses","tbOrders","tbOrdersProducts",
    "tbSessions","tbSchedule","tbTreatments"
)

foreach ($tbl in $tables) {
    $sql = "DECLARE @cols NVARCHAR(MAX), @coldefs NVARCHAR(MAX), @maxid INT; " +
        "IF EXISTS (SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id WHERE t.name='$tbl' AND c.name='ID' AND c.is_identity=1) BEGIN PRINT '$tbl already has IDENTITY'; RETURN; END; " +
        "SELECT @maxid=ISNULL(MAX(ID),0)+1 FROM [$tbl]; " +
        "SELECT @cols = STRING_AGG(QUOTENAME(c.name), ', ') FROM sys.columns c WHERE c.object_id=OBJECT_ID('$tbl') AND c.name!='ID'; " +
        "SELECT @coldefs = STRING_AGG(QUOTENAME(c.name)+' '+ty.name+" +
        "CASE WHEN ty.name IN ('nvarchar','varchar','nchar','char','varbinary') THEN '('+CASE WHEN c.max_length=-1 THEN 'MAX' ELSE CAST(c.max_length/CASE WHEN ty.name LIKE 'n%' THEN 2 ELSE 1 END AS VARCHAR) END+')' " +
        "WHEN ty.name IN ('decimal','numeric') THEN '('+CAST(c.precision AS VARCHAR)+','+CAST(c.scale AS VARCHAR)+')' " +
        "WHEN ty.name = 'text' THEN '' WHEN ty.name = 'ntext' THEN '' WHEN ty.name = 'image' THEN '' " +
        "ELSE '' END+" +
        "CASE WHEN c.is_nullable=1 THEN ' NULL' ELSE ' NOT NULL' END, ', ') " +
        "FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id WHERE c.object_id=OBJECT_ID('$tbl') AND c.name!='ID'; " +
        "EXEC('CREATE TABLE [" + $tbl + "_new] (ID INT IDENTITY('+CAST(@maxid AS VARCHAR)+',1) NOT NULL, '+@coldefs+')'); " +
        "EXEC('SET IDENTITY_INSERT [" + $tbl + "_new] ON; INSERT INTO [" + $tbl + "_new] (ID, '+@cols+') SELECT ID, '+@cols+' FROM [$tbl]; SET IDENTITY_INSERT [" + $tbl + "_new] OFF'); " +
        "EXEC('DROP TABLE [$tbl]'); " +
        "EXEC sp_rename '" + $tbl + "_new', '$tbl'; " +
        "PRINT '$tbl IDENTITY added (seed='+CAST(@maxid AS VARCHAR)+')';"

    $result = docker exec hipnoticus-mssql /opt/mssql-tools18/bin/sqlcmd -S $server -U $user -P $pass -d Hipnoticus -C -Q $sql 2>&1
    $output = ($result | Out-String).Trim()
    if ($output -match "error|Msg \d") {
        Write-Host "FAIL: $tbl - $output" -ForegroundColor Red
    } else {
        Write-Host "OK: $tbl" -ForegroundColor Green
    }
}
Write-Host "=== Done ===" -ForegroundColor Cyan
