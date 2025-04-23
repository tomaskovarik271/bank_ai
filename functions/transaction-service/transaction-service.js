const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const crypto = require('crypto'); // For UUID generation

// --- Configuration (fetch from environment variables) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE;

if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
    console.error('Transaction Service: Missing required environment variables');
}

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Initialize JWKS client for Auth0
const jwksRsaClient = jwksClient({
    jwksUri: `https://${auth0Domain}/.well-known/jwks.json`,
    cache: true,
    rateLimit: true
});

// --- Helper Functions (Reused from other services) ---

function getSigningKey(header, callback) {
    jwksRsaClient.getSigningKey(header.kid, (err, key) => {
        if (err) { return callback(err); }
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
}

async function verifyToken(req) {
    // (Same implementation as in account-service)
    return new Promise((resolve, reject) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reject({ statusCode: 401, message: 'Missing or invalid Authorization header' });
        }
        const token = authHeader.substring(7);
        jwt.verify(token, getSigningKey, { audience: auth0Audience, issuer: `https://${auth0Domain}/`, algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                console.error('JWT verification error:', err);
                return reject({ statusCode: 401, message: `Token verification failed: ${err.message}` });
            }
            resolve(decoded);
        });
    });
}

async function getCustomerIdFromAuth0Sub(auth0Sub) {
    // (Same implementation as in account-service)
     const { data, error } = await supabase
        .from('customer')
        .select('id')
        .eq('auth0_user_id', auth0Sub)
        .single();
    if (error || !data) {
        console.error(`Error fetching customer ID for auth0_sub ${auth0Sub}:`, error);
        return null;
    }
    return data.id; // Returns bigint
}

// --- Route Handler: Internal Transfer ---

async function handleInternalTransfer(req, verifiedToken) {
    let requestBody;
    try {
        requestBody = JSON.parse(req.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
    }

    const { fromAccountId, toAccountId, amount, currency, description } = requestBody;

    // === Basic Input Validation ===
    if (!fromAccountId || !toAccountId || !amount || !currency) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing required fields: fromAccountId, toAccountId, amount, currency' }) };
    }
    if (typeof amount !== 'number' || amount <= 0) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid amount: must be a positive number' }) };
    }
    if (fromAccountId === toAccountId) {
        return { statusCode: 400, body: JSON.stringify({ message: 'From and To accounts cannot be the same' }) };
    }
    if (currency.length !== 3) {
         return { statusCode: 400, body: JSON.stringify({ message: 'Invalid currency code (must be 3 letters)' }) };
    }

    try {
        // === Authorization Check ===
        const requestingCustomerId = await getCustomerIdFromAuth0Sub(verifiedToken.sub);
        if (!requestingCustomerId) {
            // This should ideally not happen if token is verified, but good practice
            return { statusCode: 403, body: JSON.stringify({ message: 'Could not identify requesting customer' }) };
        }

        // Verify the user owns the 'from' account
        const { data: fromAccountData, error: fromAccountError } = await supabase
            .from('accounts')
            .select('customer_id')
            .eq('id', fromAccountId)
            .single();

        if (fromAccountError || !fromAccountData) {
            console.error(`Error fetching fromAccount ${fromAccountId}:`, fromAccountError);
            return { statusCode: 404, body: JSON.stringify({ message: `Debit account not found: ${fromAccountId}` }) };
        }

        if (fromAccountData.customer_id !== requestingCustomerId) {
            console.warn(`Auth mismatch: Token sub ${verifiedToken.sub} (customer ${requestingCustomerId}) tried to transfer from account ${fromAccountId} owned by customer ${fromAccountData.customer_id}`);
            return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: You do not own the source account.' }) };
        }

        // === Prepare for Ledger Posting ===
        const transactionId = crypto.randomUUID();
        const upperCaseCurrency = currency.toUpperCase();

        // === Call Ledger Posting RPC Function ===
        const { error: rpcError } = await supabase.rpc('post_ledger_transaction', {
            p_transaction_id: transactionId,
            p_debit_account_id: fromAccountId,
            p_credit_account_id: toAccountId,
            p_amount: amount,
            p_currency: upperCaseCurrency,
            p_description: description // Pass optional description
        });

        // === Handle RPC Response ===
        if (rpcError) {
            console.error('Error calling post_ledger_transaction RPC:', rpcError);

            // Attempt to extract the user-friendly error message raised by the DB function
            const dbErrorMessage = rpcError.message?.includes('EXCEPTION:')
                ? rpcError.message.split('EXCEPTION:')[1].trim()
                : 'Transaction failed due to database error.';

            // Return 422 for expected business rule violations caught by the DB function
            return {
                statusCode: 422, // Unprocessable Entity
                body: JSON.stringify({
                    message: 'Transaction failed.',
                    details: dbErrorMessage,
                    transactionId: transactionId // Include ID for tracing
                 })
            };
        }

        // === Success ===
        console.log(`Internal transfer completed successfully. Transaction ID: ${transactionId}`);
        return {
            statusCode: 200, // Or 202 Accepted if we switch to async later
            body: JSON.stringify({
                transactionId: transactionId,
                status: 'COMPLETED' // Assuming synchronous completion for now
            })
        };

    } catch (err) {
        console.error('Unexpected error in handleInternalTransfer:', err);
        return { statusCode: 500, body: JSON.stringify({ message: `Internal server error: ${err.message}` }) };
    }
}

// --- Main Handler ---
exports.handler = async (event, context) => {
     if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
       return { statusCode: 500, body: JSON.stringify({ message: 'Transaction Service: Server configuration error: Missing environment variables.' }) };
    }

    const path = event.path.replace('/api/transaction-service', '');
    const method = event.httpMethod;

    console.log(`Transaction Service Request: ${method} ${path}`);

    try {
        const verifiedToken = await verifyToken(event);
        console.log(`Transaction Service: Token verified for user: ${verifiedToken.sub}`);

        // Routing
        if (method === 'POST' && path === '/transfers/internal') {
            return await handleInternalTransfer(event, verifiedToken);
        }
        // Add other routes here later (e.g., get transaction status)
        else {
            return { statusCode: 404, body: JSON.stringify({ message: 'Transaction Service: Route not found' }) };
        }

    } catch (error) {
        console.error('Transaction Service: Unhandled error:', error);
        const statusCode = error.statusCode || 500;
        const message = error.message || 'Internal Server Error';
        return { statusCode: statusCode, body: JSON.stringify({ message: message }) };
    }
}; 