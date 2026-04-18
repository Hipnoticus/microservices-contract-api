# Hipnoticus Project Context — April 16, 2026
## For continuing development on another machine

---

## Project Overview
Hipnoticus clinical management platform — legacy ASP.NET WebForms migrating to microservices + Angular 17 (Moses).

## Workspace Paths
- Microservices: H:\Hipnoticus\Web\Applications\public_application\microservices
- Moses (Angular): H:\Hipnoticus\Web\Applications\public_application\moses
- Legacy cliente: H:\Hipnoticus\Web\Applications\public_application\cliente
- Database Runtime: H:\Hipnoticus\IT\Database\Runtime

## Running Services (docker compose)
All services run via `docker compose up -d` from the microservices directory.
- Gateway: localhost:8080
- Moses: localhost:4200
- ContractAPI (NestJS/Bun): port 3002
- QuestionnaireAPI (.NET 8): port 2001
- EmailAPI (Spring Boot): port 8100
- SessionAPI: port 8083
- CustomerAPI (.NET): port 2000
- CustomerAddressAPI: port 8084
- MSSQL (dev): hipnoticus-mssql, port 1433, sa/Hipno8991!!
- Redis: port 6379

## Database Configuration
- DEV: All services now point to local hipnoticus-mssql (compose.yml has DB_URL overrides)
- PROD: mssql2.hipnoterapia.org (DO NOT connect dev services to prod)
- The .env JDBC URL was changed to point to dev. Java services get DB_URL from compose env vars.
- .NET services get ConnectionStrings__Hipnoticus from compose env vars.

## What Was Built (This Session)

### 1. Boleto + PIX Payment (ContractAPI + Moses)
- BancoInterGateway: boleto creation, PDF retrieval, PIX cobranca, webhook registration
- CieloGateway: credit card processing
- ProcessPaymentUseCase: orchestrates payment, generates static PIX BR Code as fallback
- Confirmation page shows: QR code image (via qrserver.com API), PIX Copia e Cola, boleto linha digitavel, PDF link
- Boleto PDF served via GET /payments/boleto-pdf/:nossoNumero
- Frontend boleto URL uses getBoletoFullUrl() pointing to gateway (environment.API_URL)

### 2. Payment Confirmation System
- Banco Inter webhook: POST /payments/webhook/banco-inter (registered automatically on startup)
- Background polling: PaymentPollingService checks pending orders every 5 min against Banco Inter API
- Frontend polling: 3-second interval on confirmation page, shows "Pagamento Confirmado!" banner
- Manual confirm: POST /payments/confirm/:orderId
- Status check: GET /payments/status/:orderId

### 3. Session Creation (CreateSessionsUseCase)
- On payment confirmation: creates tbTreatments record + 1a Consulta + N weekly sessions in tbSessions
- Session count extracted from product name ("10 Sessoes - 4 Meses")
- Status: 23 (Consulta) for 1a Consulta, 1 (Confirmada) for sessions

### 4. Confirmation Emails (SendConfirmationEmailUseCase)
- Loads HTML templates from tbConfig (client.email.boletodata, carddata, depositodata + _cliente_success variants)
- Replaces all legacy placeholders ([NOME_CLIENTE], [CPF_CLIENTE], etc.)
- Sends via EmailAPI (Zoho OAuth2): POST /email-service/send
- Two emails per order: one to contato@hipnoterapia.org, one to customer

### 5. Questionnaire Migration (QuestionnaireAPI + Moses)
Backend endpoints added:
- GET /questionnaires/{id}/questions — questions with answer options
- POST /answers/submit — submit answer (idempotent), auto-advances, updates status on completion
- GET /requests/{hash}/progress — current progress for a request
- GET /results/phases/customer/{customerId} — results grouped by treatment phase
- GET /results/request/{requestHash} — results for specific answering session

Frontend:
- ResponderQuestionarioComponent at /questionarios/responder/:hash — one question at a time, progress bar, Sim/Nao buttons
- Resultados page redesigned with phase navigation (Pre-Tratamento / Tratamento / Pos-Tratamento)
- Questionnaire list shows "Responder" button linking to answering page

### 6. Order Status Flow
- New orders: status 1 (Pendente)
- Payment confirmed: status 2 (Em Analise)
- Status 3 = Confirmado, Status 4 = Cancelado

### 7. UI Fixes
- Navbar: unwraps res.value from CustomerAPI response, shows actual user name
- Meus Dados: save button works (PUT /customer-service/customers/{id}), unwraps res.value
- Dark theme: improved contrast, inline style overrides for scheduling cards
- Session summary text: green color (#2f855a), dark theme override to #68d391
- Dashboard legends: "93% Emocional" as title, "93% Emocional / 7% Fisica" as detail
- Bem-Estar scoring: fixed to use No answers (well-being) instead of Yes answers (problems)

## Key Database Tables
- tbOrders: CustomerID, OrderStatusID, Total, FirstAppointmentDay/Hour, SessionDay/Hour
- tbSessions: OrderNumber, ClientID, Treatment, DateBegins/DateEnds, Status, Value, PaymentType(int)
- tbSchedule: same structure as tbSessions (booking ledger)
- tbTreatments: MainGoal, Customer, OrderNumber, SessionsNumber, PhaseDefined, PhaseDetected
- tbTreatmentsPhases: 1=Pre-Tratamento, 2=Tratamento, 3=Pos-Tratamento
- tbQuestionnairesRequests: Hash(GUID), ClientID, Treatment, Questionnaire, Status
- tbQuestionnairesAnswersRecords: Questionnaire, Question, Answer, Customer, Request(GUID)
- tbOrdersStatus: 1=Pendente, 2=Em Analise, 3=Confirmado, 4=Cancelado
- tbSessionsStatus: 1=Confirmada, 3=Reservada, 5=Cancelada, 9=Pagamento Pendente, 21=Acompanhamento, 23=Consulta
- tbCustomers: FirstName, LastName, CPFCNPJ, Email, PhoneNumber (NOT CPF, NOT TelCelular)
- tbProducts: ID, Name, NormalPrice, PromotionalPrice (packages like "10 Sessoes - 4 Meses")
- tbOrdersProducts: OrderID, ProductID, ProductName

## Test Customer
- Gabriel Veloso, ID 43, CPF 10962509779, email punkore8@gmail.com
- Has 6 answered questionnaires (QSK 1, QSK 2, QSXKM 1, QSXKM 2, QABEG, QDH)
- Male client — no feminine questionnaires (QSXKF)

## Banco Inter Integration
- OAuth2 mTLS with cert/key files in /app/certs/
- PIX API scope NOT registered for this client (cob.write fails) — using static PIX BR Code as fallback
- Boleto webhook registered at: https://moses.hipnoticus.com.br/contract-service/payments/webhook/banco-inter
- PIX key (CNPJ): 12344385000193

## Known Issues / TODO
- PIX API scope needs to be enabled in Banco Inter portal for dynamic PIX cobranca
- EmailAPI returns 404 for /send endpoint (needs context-path check: /email-service/send)
- Questionnaire results by specific request hash (per-session results) — currently falls back to customer-level
- Questionnaire multi-answer: data model supports it, UI needs timeline/comparison view
- Session creation needs to check slot availability before inserting
- The system should support multiple questionnaire answers per client (different phases/treatments)
- Each questionnaire request is tied to a treatment which has PhaseDefined/PhaseDetected

## Git Repos (all pushed to origin/main)
- microservices: 1a6830b
- ContractAPI: 3be951cf
- QuestionnaireAPI: 73ffa3a
- Moses: 5214b6d
- Database: 26068635f
