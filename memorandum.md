# Core Banking System on Netlify - Architecture Memorandum

## 1. Goal

Build a core banking system using microservices deployed on Netlify. The system must be fully compliant with relevant regulations.

## 2. Architecture Principles

- **Microservices:** Decompose functionality into independent services.
- **Serverless:** Leverage Netlify Functions for backend logic.
- **Compliance First:** Ensure all design choices meet regulatory requirements.
- **Leverage Off-the-Shelf Components:** Utilize existing solutions for common concerns like IAM, security, database, etc., where possible.
- **Netlify Integration:** Maximize the use of Netlify features (e.g., Identity, Forms, Analytics, Edge Functions) where appropriate.
- **Open Banking Standard:** Adhere to the principles and specifications of the UK Open Banking Standard ([openbanking.org.uk](https://openbanking.org.uk/)) for API design, security profiles (FAPI), and data models where applicable, promoting interoperability and best practices.

## 3. Key Considerations

- **IAM (Identity and Access Management):** How will users (customers, staff) be managed? Can Netlify Identity suffice or is a dedicated solution (e.g., Auth0, Okta) needed?
    - **Status:** Netlify Identity is **deprecated** and not recommended for new projects.
    - **Chosen Option:** **Auth0 (or similar, e.g., Okta)**
        - **Rationale:** Dedicated, mature IAM SaaS platform. Provides comprehensive features (MFA, advanced RBAC, detailed audit logs, user management for different types), strong security posture, and readily available compliance certifications (SOC 2, ISO 27001, etc.) crucial for banking. Aligns with the principle of leveraging managed, off-the-shelf components to reduce operational burden.
        - **Integration:** Requires integration using standard JWTs. Netlify Functions will need to validate tokens signed by Auth0. Access control logic will likely reside within the functions or rely on API gateway policies, potentially using Auth0's authorization features.
        - **Considerations:** Cost, configuration complexity (compared to simpler solutions), potential need for Netlify Enterprise features for seamless edge-based access control using external JWTs.
    - **Alternative Option:** **Keycloak**
        - **Rationale:** Powerful, feature-rich open-source IAM solution. Offers comparable features to Auth0/Okta. Provides full control if self-hosted.
        - **Considerations:** Significant operational overhead if self-hosted (deployment, scaling, maintenance, security, compliance). Managed Keycloak options exist but require vetting. May conflict with the goal of minimizing operations.
    - **Alternative Option:** **Supabase Auth**
        - **Rationale:** Actively maintained fork of Netlify Identity's underlying tech (GoTrue). Integrates well with Supabase DB, potentially simplifying stack.
        - **Considerations:** Feature set might be less comprehensive than Auth0/Keycloak, especially regarding advanced MFA, complex authorization policies, and enterprise compliance features needed for banking. Requires careful evaluation against strict requirements.
- **Security:** Data encryption (at rest, in transit), API security, vulnerability management, logging, auditing.
    - **Data Encryption:**
        - *In Transit:* Enforce TLS 1.2+ for all connections (Client <-> Netlify, Function <-> Supabase, Function <-> Auth0, Function <-> VGS, inter-function). Verify library defaults.
        - *At Rest:* Configure Supabase disk encryption. Evaluate/implement column-level or application-level encryption for specific sensitive fields using secure key management. Utilize VGS for tokenizing PCI-scope data (e.g., PANs).
    - **API Security (Netlify Functions):**
        - *Standard Compliance:* API design to follow Open Banking specifications. Requires security profile compliance (e.g., FAPI via Auth0).
        - *Authentication:* Mandatory Auth0 JWT validation on all function endpoints.
        - *Authorization:* Fine-grained checks within functions based on JWT roles/permissions (least privilege, deny by default).
        - *Input Validation:* Strict validation of all inputs (params, query, body) using robust libraries.
        - *Secrets Management:* Use Netlify Environment Variables for all secrets (DB connection, API keys, etc.). Implement rotation. Avoid hardcoding.
        - *Rate Limiting:* Utilize Netlify capabilities or implement custom logic.
        - *Output Encoding:* Ensure proper encoding of outputs to prevent XSS.
        - *Security Headers:* Configure CSP, HSTS, etc., via Netlify headers.
    - **Vulnerability Management:**
        - *Dependency Scanning:* Integrate automated scanning (e.g., Snyk, npm audit) in CI/CD.
        - *Code Scanning (SAST):* Integrate SAST tools in CI/CD.
        - *Patching:* Regularly update dependencies; monitor Netlify runtime updates, Supabase/Auth0 advisories.
        - *Penetration Testing:* Schedule regular third-party tests.
    - **Logging and Auditing:**
        - *Comprehensive Logging:* Configure detailed security event logging in Netlify Functions, Supabase, and Auth0. Avoid logging sensitive data.
        - *Centralization & Retention:* Use log drains to forward logs to a central SIEM. Implement retention policies per compliance requirements.
        - *Monitoring & Alerting:* Configure SIEM alerts for critical security events and anomalies.
    - **Network Security:**
        - *Supabase Access Control:* Configure Supabase network restrictions. Consider Netlify Private Connectivity for static egress IPs if needed.
        - *WAF:* Evaluate Netlify WAF or other WAF solutions.
- **Database:** What kind of database is suitable? How will it be hosted and accessed securely from Netlify Functions?
    - **Chosen Option:** **Supabase (PostgreSQL)**
        - **Rationale:** Mature relational database (PostgreSQL) suitable for banking data integrity and transactions. Designed for serverless environments with features like managed connection pooling (via clients/ORMs) and APIs. Offers essential security features (RLS, SSL). Reduces operational overhead as a managed service.
        - **Security Considerations:** Requires careful configuration of Row Level Security (RLS), network policies (if applicable), encryption settings, and robust access control from Netlify Functions. Connection strings and API keys must be securely managed (e.g., Netlify environment variables).
        - **Compliance:** Need to verify Supabase's specific compliance certifications (e.g., SOC 2, ISO 27001, PCI DSS applicability) against requirements and configure data residency if necessary. Audit logging capabilities need assessment.
        - **Data Model:** Schema design should align with Open Banking data standards where applicable.
    - **Complementary Service:** **Very Good Security (VGS)**
        - **Consideration:** Explore using VGS to tokenize/vault highly sensitive data (PII, account numbers) *before* it reaches Supabase. This can significantly reduce the compliance scope (e.g., PCI DSS) of the database itself.
- **Compliance:** Which specific regulations apply (e.g., PCI DSS, GDPR, local banking laws)? How will compliance be audited and maintained?
    - **Target Jurisdictions:** US & EU.
    - **Key Applicable Regulations:**
        - **US:**
            - *Gramm-Leach-Bliley Act (GLBA):* Data privacy and security for financial data.
            - *Bank Secrecy Act (BSA) / Anti-Money Laundering (AML):* KYC, transaction monitoring, reporting.
            - *Payment Card Industry Data Security Standard (PCI DSS):* Mandatory if handling cardholder data. Very prescriptive.
            - *State-Level Laws (e.g., CCPA/CPRA, NYDFS):* Additional privacy and security rules.
        - **EU:**
            - *General Data Protection Regulation (GDPR):* Strict rules on personal data processing, consent, rights, security, breach notification, data residency.
            - *Payment Services Directive (PSD2):* Strong Customer Authentication (SCA), secure communication, Open Banking APIs (if applicable).
            - *EBA Guidelines:* Detailed expectations for ICT risk management, security, outsourcing.
    - **Additional Standards/Frameworks (especially if pursuing payment licenses):**
        - *ISO 27001:* International standard for Information Security Management Systems (ISMS). Demonstrates robust security governance.
        - *SOC 2 (Type II):* Attestation standard for service organizations, covering Security, Availability, Processing Integrity, Confidentiality, Privacy controls. Essential for B2B services and vendor trust.
        - *NIST Cybersecurity Framework (US):* Widely adopted framework for managing cybersecurity risk; often referenced by US regulators.
        - *State Money Transmitter Licenses (US):* Specific state-level requirements covering capital, bonding, BSA/AML programs, cybersecurity.
        - *Further EBA Guidelines (EU):* Detailed requirements on internal governance, outsourcing, etc., related to payment institution licensing.
    - **High-Level Implications for Architecture:**
        - *Authentication:* Robust MFA/SCA (Auth0 suitable).
        - *Encryption:* Mandatory end-to-end (HTTPS/TLS) and at-rest (Supabase, application-level, VGS for PCI).
        - *Access Control:* Strict least privilege (Supabase RLS, Auth0 roles, API security).
        - *Audit Trails:* Comprehensive, immutable logging across all components (Functions, DB, IAM). Requires evaluating tool capabilities and potentially integrating dedicated logging/SIEM.
        - *Data Privacy/Residency (GDPR):* Mechanisms for consent, data subject rights. Careful vendor selection/configuration for data storage location.
        - *Vulnerability Management:* Continuous scanning, patching, secure coding.
        - *Vendor Due Diligence:* Review compliance posture of Netlify, Supabase, Auth0, Inngest etc. (SOC 2, ISO 27001, PCI DSS, DPAs). This becomes even more critical for licensing.
- **Consent Management:** How will user consent for data access (AIS) and payment initiation (PIS), as required by Open Banking and GDPR, be captured, stored securely (e.g., in Supabase), managed (revocation), and enforced at the API level?
- **Scalability & Reliability:** How will the system handle load? What are Netlify's guarantees?
    - **Scalability:**
        - *Netlify Functions:* Auto-scaling compute. Subject to concurrency, execution time, memory limits (plan-dependent).
        - *Supabase:* Tier-dependent scaling. Monitor connections, queries. Plan for DB scaling.
        - *Auth0:* Managed SaaS, scales automatically (check plan limits).
        - *Messaging Service:* Managed services typically auto-scale (check quotas).
    - **Reliability:**
        - *Netlify Platform:* High availability infrastructure (CDN, underlying cloud). SLA available. Atomic deploys & rollbacks enhance reliability.
        - *Supabase:* Managed backups, PITR, HA options (tier-dependent). SLA available.
        - *Auth0:* Managed SaaS with high availability and SLA.
        - *Messaging Service:* High durability/availability via managed services. Use Dead-Letter Queues (DLQs) for fault tolerance.
            - **Chosen Option:** **Inngest** (instead of traditional queue like SQS). Rationale below.
        - *Application Design:* Asynchronous patterns, idempotent functions, robust error handling, and comprehensive monitoring are crucial for overall system reliability.
    - **Strategy:** Leverage managed service scaling/reliability. Focus on database performance/scaling. Design for resilience using async patterns, idempotency. Monitor closely. Review SLAs.
- **Inter-service Communication:** How will microservices communicate (e.g., synchronous REST APIs, asynchronous events)?
    - **Context:** Communication between Netlify Functions (microservices).
    - **Patterns:**
        - *Synchronous (Direct HTTP Calls):* Function A calls Function B's URL directly and waits.
            - *Pros:* Simple for request/response; immediate feedback.
            - *Cons:* Tight coupling; reduced resilience (cascading failures); latency buildup; potential bottlenecks.
            - *Use When:* Sparingly, for essential, immediate data retrieval (queries) where coupling is acceptable. Secure internal calls (e.g., shared secret header).
        - *Asynchronous (Events/Messages/Workflows):* Functions communicate indirectly via an external platform.
            - **Chosen Platform:** **Inngest**
                - *Rationale:* Combines event stream, queuing, scheduling, and durable execution (steps, retries, sleeps, waits) into one platform. Strong focus on Developer Experience (DX) for serverless (Netlify). Built-in observability and local dev server. SOC 2 compliant.
                - *Pros:* Simplifies complex workflows, manages state between steps, built-in retries/concurrency control, good DX.
                - *Cons:* Newer platform vs. AWS/GCP services; specific banking compliance needs deeper vetting; potential cost at high scale.
            - *Use When:* Default choice for commands, events triggering actions/state changes, background tasks, complex multi-step workflows requiring resilience.
    - **Recommendation:** **Hybrid Approach**
        - Prioritize **Asynchronous Communication & Workflows via Inngest** for decoupling, resilience, and managing complex logic.
        - Use **Synchronous Communication** sparingly for necessary queries.
    - **Next Step:** Perform detailed review of Inngest's compliance documentation (SOC 2 report details, GDPR posture, etc.) against specific banking requirements (GLBA, etc.). Evaluate pricing model against expected load.
    - **Next Step:** Perform detailed review of Inngest's compliance documentation... Evaluate Auth0 FAPI compliance capabilities.
- **State Management:** How will application state be managed, especially in a serverless environment?
    - **Challenge:** Netlify Functions are stateless; state must be managed externally.
    - **Persistent Business State:**
        - *Source of Truth:* **Supabase (PostgreSQL)** (account details, balances, transactions, user profiles, etc.).
        - *Access:* Functions read/write state using Supabase. Use ACID transactions for atomic DB operations.
    - **Workflow State (Multi-Step Processes):**
        - *Challenge:* Tracking state across multiple asynchronous function invocations.
        - *Primary Approach:* Store workflow state in dedicated Supabase tables, updated by functions processing asynchronous events/messages.
        - *Alternatives (if needed):* Dedicated workflow orchestrators (e.g., AWS Step Functions, Temporal) or stateful features of the eventing system (requires evaluation).
    - **Short-Term / Session State:**
        - *Client-Side:* Browser storage / UI state libraries for non-sensitive UI state.
        - *Server-Side Cache:* Consider managed **Redis** (e.g., Upstash, Aiven) only if required for performance-critical temporary state sharing between functions.
        - *JWT:* Contains identity info, not for general state.
    - **Consistency:**
        - *Database:* Rely on Supabase ACID transactions.
        - *Distributed Workflows:* Design for **eventual consistency**. Use Saga pattern if distributed atomicity needed. Ensure function idempotency.
    - **Recommendation:** Use Supabase for persistent and initial workflow state. Leverage asynchronous messaging for state transitions. Design for eventual consistency. Introduce external caching (Redis) only if necessary.
- **Testing:** How will unit, integration, and end-to-end tests be implemented?
    - **Strategy:** Implement a multi-layered testing approach integrated into CI/CD.
    - **Layers:**
        - *Unit Testing:* Test individual function logic in isolation. Use Node.js frameworks (Jest, Mocha, etc.) with extensive mocking of external dependencies (DB, IAM, Queue, HTTP calls).
        - *Integration Testing:* Test function interactions with direct external services (Supabase, Auth0, Message Queue). Use test instances/databases (e.g., Supabase local dev) where possible.
        - *Contract Testing:* Ensure API/message consumers and providers adhere to agreed contracts (e.g., using Pact, OpenAPI tools, schema validation). Crucial for sync HTTP and async messages.
        - *End-to-End (E2E) Testing:* Test critical user workflows across the full stack (UI -> Functions -> DB -> IAM). Use UI automation (Cypress, Playwright) or API-level tests against deployed environments (Netlify Deploy Previews, staging).
        - *Security Testing:* Integrate automated tools (SAST, dependency scanning) in CI/CD. Perform regular DAST and manual penetration testing.
        - *Compliance Testing:* Verify implementation of specific regulatory controls (audit logs, access control, data handling) via automated checks and manual reviews.
    - **Tooling & Environments:** Automate heavily. Leverage Netlify Deploy Previews for testing PRs. Use `netlify dev` and Supabase local dev for local testing. Employ robust mocking strategies.
- **Deployment:** How will CI/CD be set up?
    - **Core Principles:** Git-driven, automation, distinct environments, immutability, safety (approvals, rollbacks).
    - **Platform:** Netlify integrated with Git provider (GitHub, GitLab, etc.).
    - **Branching Strategy:** Standard flow (e.g., Gitflow: main, develop, feature branches).
    - **Netlify CI/CD Configuration:**
        - Configure build commands, function dirs (`netlify.toml`).
        - Utilize Netlify build hooks/plugins if needed.
    - **Pipeline Stages:**
        - *Pull Request:* Trigger build, comprehensive tests (Unit, Integration, Contract, SAST, Dependency Scan), deploy to Netlify Deploy Preview. Gate merge on success.
        - *Staging:* Triggered on merge to `develop`/`staging`. Build, test (inc. E2E), deploy to dedicated Staging environment. Allow UAT.
        - *Production:* Triggered by promotion/merge to `main`. **Requires manual approval gate**. Deploy atomically. Run smoke tests.
    - **Database Migrations (Supabase):**
        - Use migration tool (Supabase CLI, Prisma Migrate), store migrations in Git.
        - Integrate migration application into pipeline *before* dependent code deployment.
        - Requires careful orchestration and testing across environments.
    - **Secrets Management:**
        - Use Netlify Environment Variables scoped per context (Production, Deploy Preview, etc.).
    - **Rollbacks:**
        - Leverage Netlify's instant rollback feature for quick recovery.

## 4. Proof of Concept (PoC) Summary

- **Goal:** Validate core architecture (Netlify Functions, Auth0, Supabase) for user signup/login and basic data interaction.
- **Scope:**
    - Frontend UI (HTML/JS) for Auth0 login/signup.
    - Auth0 integration using SPA SDK.
    - `customer-service` Netlify Function with endpoints for:
        - `POST /create`: Triggered post-login to upsert customer data (email, `auth0_user_id`) into Supabase.
        - `GET /profile`: Fetches customer data from Supabase based on validated Auth0 JWT.
- **Outcome:** **Successful**. The PoC demonstrated:
    - Correct configuration and integration of Auth0 for authentication.
    - Secure JWT validation within a Netlify Function.
    - Interaction with Supabase using the service role key from a Netlify Function.
    - Basic end-to-end flow from frontend login to backend data retrieval.
    - Confirmed viability of the core stack (Netlify Functions + Auth0 + Supabase).

## 5. Next Steps

-   **Design and Develop Core Services (Priority):**
    -   **`account-service`:** Design API and data model according to Open Banking standards (Current Focus).
    -   Flesh out `customer-service` (e.g., profile update, KYC trigger placeholder).
    -   Design and implement `transaction-service` (basic transfer logic using Inngest PoC, align with OB PIS).
    -   Design `ledger-service` (or DB implementation).
    -   Design `notification-service`.
    -   Design **`consent-management-service`** (or integrate logic into other services).
-   **Refine Technology Choices:**
    -   Perform detailed review of Inngest's compliance documentation (SOC 2 report details, GDPR posture, etc.) against specific banking requirements (GLBA, etc.). Evaluate pricing model against expected load.
    -   Perform deeper compliance/security review of Supabase and Auth0 configurations, focusing on FAPI/OB requirements.
-   **Implement Key Security Controls:** Start hardening the implementation based on the Security section (e.g., FAPI compliance, stricter input validation, centralized logging setup, advanced RLS in Supabase, consent enforcement).
-   **Establish CI/CD Pipelines:** Fully implement the automated testing and deployment pipelines outlined.
-   **Define Microservices (Initial Set - Confirmed):**
    -   `customer-service` (PoC started)
    -   `account-service`
    -   `transaction-service`
    -   `ledger-service`
    -   `notification-service`
    -   `consent-management-service`

*Previous Steps included PoC which is now complete.*

## 6. Service Designs

### account-service

*(Design details to be added here, referencing Open Banking Account and Transaction API spec: Responsibilities, API Endpoints, Data Model, Dependencies)*

**1. Core Responsibilities:**

- Create new bank accounts (Checking, Savings) associated with a verified `customer_id`.
- Retrieve detailed information for a specific account, including calculated balance.
- List all accounts belonging to a specific customer.
- Update account status (e.g., active, dormant, closed).
- Generate unique, non-predictable account numbers.
- Interface with the `ledger-service` (or underlying ledger tables) to determine account balances.
- Potentially trigger asynchronous background jobs (via Inngest) for tasks like statement generation.

**2. Proposed API Endpoints (Internal):**

*   `POST /api/account-service/accounts`
    *   Action: Create account.
    *   Body: `{ customerId, accountType, currency, nickname? }`
    *   Response: `201 Created` with new account details.
*   `GET /api/account-service/accounts?customerId={customerId}`
    *   Action: List accounts for customer.
    *   Response: `200 OK` with array of account summaries.
    *   AuthZ: User must be authorized for `customerId`.
*   `GET /api/account-service/accounts/{accountId}`
    *   Action: Get specific account details (inc. balance from ledger).
    *   Response: `200 OK` with account details.
    *   AuthZ: User must be authorized for `accountId`.
*   `PATCH /api/account-service/accounts/{accountId}`
    *   Action: Update account status.
    *   Body: `{ status }`
    *   Response: `200 OK` with updated account.
    *   AuthZ: Requires appropriate permissions.

**3. Proposed Data Model (`accounts` table in Supabase):**

```sql
CREATE TYPE public.account_type_enum AS ENUM ('CHECKING', 'SAVINGS');
CREATE TYPE public.account_status_enum AS ENUM ('ACTIVE', 'DORMANT', 'PENDING_CLOSURE', 'CLOSED');

CREATE TABLE public.accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    customer_id uuid NOT NULL REFERENCES public.customer(id),
    account_number text NOT NULL UNIQUE,
    account_type public.account_type_enum NOT NULL,
    status public.account_status_enum NOT NULL DEFAULT 'ACTIVE'::public.account_status_enum,
    currency character(3) NOT NULL DEFAULT 'USD'::bpchar,
    nickname text NULL
    -- Balance calculated from ledger
);
CREATE INDEX idx_accounts_customer_id ON public.accounts(customer_id);
CREATE INDEX idx_accounts_account_number ON public.accounts(account_number);
```

**4. Design Decisions & Considerations:**

*   **Account Number Generation:** Needs defining (e.g., DB function, separate service). Start simple (random generation + collision check in code).
*   **Balance Management:** Balance NOT stored in `accounts` table; retrieved from ledger service/tables.
*   **Data Types:** Use ENUMs for type/status. UUID for ID. `character(3)` for currency.

**5. Dependencies:**

*   `customer-service` (via `customer_id` FK)
*   `ledger-service` (or direct DB access for balance)
*   Auth0 (JWT validation)
*   Inngest (optional, for background tasks)

### customer-service

*(Refinement details to be added here)*

### transaction-service

*(Design details to be added here)*

### ledger-service

*(Design details to be added here)*

### notification-service

*(Design details to be added here)*

### consent-management-service

*(Design details to be added here: Responsibilities, API Endpoints, Data Model for consent storage, Dependencies)* 