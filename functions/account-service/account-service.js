const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const crypto = require('crypto'); // For random account number generation

// --- Configuration (fetch from environment variables) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE;

if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
    console.error('Account Service: Missing required environment variables');
}

// Initialize Supabase client (use service role key for backend operations)
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Initialize JWKS client for Auth0
const jwksRsaClient = jwksClient({
    jwksUri: `https://${auth0Domain}/.well-known/jwks.json`,
    cache: true, // Enable caching
    rateLimit: true // Enable rate limiting
});

// --- Helper Functions ---

// Function to get the signing key from Auth0 (Cached)
function getSigningKey(header, callback) {
    jwksRsaClient.getSigningKey(header.kid, (err, key) => {
        if (err) {
            console.error('Error getting signing key:', err);
            return callback(err);
        }
        const signingKey = key.publicKey || key.rsaPublicKey;
        callback(null, signingKey);
    });
}

// Middleware to verify the Auth0 JWT
async function verifyToken(req) {
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

// Helper to get customer ID from Auth0 sub
async function getCustomerIdFromAuth0Sub(auth0Sub) {
    const { data, error } = await supabase
        .from('customer')
        .select('id')
        .eq('auth0_user_id', auth0Sub)
        .single();

    if (error || !data) {
        console.error(`Error fetching customer ID for auth0_sub ${auth0Sub}:`, error);
        return null;
    }
    return data.id; // Returns the bigint customer ID
}

// --- Account Number Generation (Basic) ---
// !! WARNING: Basic implementation, not suitable for production !!
// Replace with a dedicated service or more robust DB mechanism.
async function generateUniqueAccountNumber(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        // Generate a random 10-digit number string
        const candidate = crypto.randomInt(1000000000, 9999999999).toString();

        // Check if it already exists
        const { data, error } = await supabase
            .from('accounts')
            .select('account_number')
            .eq('account_number', candidate)
            .maybeSingle(); // Use maybeSingle to check existence without error

        if (error) {
            console.error("DB error checking account number uniqueness:", error);
            throw new Error("Database error during account number generation"); // Fail fast on DB error
        }

        if (!data) {
            // Does not exist, unique!
            return candidate;
        }
        // Collision, loop again
        console.warn(`Account number collision detected for ${candidate}, retrying...`);
    }
    // Failed after retries
    throw new Error("Failed to generate a unique account number after multiple attempts.");
}


// --- Route Handlers ---

async function handleCreateAccount(req, verifiedToken) {
    let requestBody;
    try {
        requestBody = JSON.parse(req.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
    }

    const { customerId, accountType, currency, nickname } = requestBody;

    // Basic validation
    if (!customerId || !accountType || !currency) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing customerId, accountType, or currency' }) };
    }
    if (!['CHECKING', 'SAVINGS'].includes(accountType)) {
         return { statusCode: 400, body: JSON.stringify({ message: 'Invalid accountType' }) };
    }
    if (currency.length !== 3) {
         return { statusCode: 400, body: JSON.stringify({ message: 'Invalid currency code' }) };
    }

    // Authorization: Ensure the token owner matches the customerId being operated on
    const requestingCustomerId = await getCustomerIdFromAuth0Sub(verifiedToken.sub);
    if (!requestingCustomerId || requestingCustomerId !== parseInt(customerId, 10)) { // Ensure type match (bigint vs string/number)
         console.warn(`Auth mismatch: Token sub ${verifiedToken.sub} (customer ${requestingCustomerId}) tried to create account for customer ${customerId}`);
         return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: You can only create accounts for yourself.' }) };
    }


    try {
        const accountNumber = await generateUniqueAccountNumber();

        const { data, error } = await supabase
            .from('accounts')
            .insert({
                customer_id: requestingCustomerId, // Use the verified ID
                account_number: accountNumber,
                account_type: accountType,
                currency: currency.toUpperCase(),
                nickname: nickname // Will be null if not provided
            })
            .select()
            .single();

        if (error) {
            console.error('Supabase insert error creating account:', error);
            // Check for specific errors like FK violation if customerId doesn't exist
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error creating account', details: error.message }) };
        }

        console.log(`Account created successfully with ID: ${data.id}`);
        return { statusCode: 201, body: JSON.stringify(data) };

    } catch (err) {
        console.error('Unexpected error in handleCreateAccount:', err);
        return { statusCode: 500, body: JSON.stringify({ message: `Internal server error: ${err.message}` }) };
    }
}

async function handleListAccounts(req, verifiedToken) {
    // Extract customerId from query string
    const customerIdQuery = req.queryStringParameters?.customerId;

    if (!customerIdQuery) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing customerId query parameter' }) };
    }

    // Authorization: Ensure the token owner matches the customerId being requested
    const requestingCustomerId = await getCustomerIdFromAuth0Sub(verifiedToken.sub);
     if (!requestingCustomerId || requestingCustomerId !== parseInt(customerIdQuery, 10)) {
         console.warn(`Auth mismatch: Token sub ${verifiedToken.sub} (customer ${requestingCustomerId}) tried to list accounts for customer ${customerIdQuery}`);
         return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: You can only list your own accounts.' }) };
    }

    try {
        // Fetch accounts first
        const { data: accounts, error: accountsError } = await supabase
            .from('accounts')
            .select('id, account_number, account_type, status, currency, nickname') // Select summary fields
            .eq('customer_id', requestingCustomerId); // Filter by verified ID

        if (accountsError) {
            console.error('Supabase select error listing accounts:', accountsError);
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error listing accounts', details: accountsError.message }) };
        }

        if (!accounts || accounts.length === 0) {
             return { statusCode: 200, body: JSON.stringify([]) }; // Return empty array if no accounts
        }

        // Fetch balance for each account using RPC
        const accountsWithBalance = await Promise.all(accounts.map(async (acc) => {
            try {
                const { data: balanceData, error: balanceError } = await supabase.rpc('calculate_balance', {
                    p_account_id: acc.id // Pass the account UUID
                });

                if (balanceError) {
                    console.error(`Error calculating balance for account ${acc.id}:`, balanceError);
                    return { ...acc, balance: 'Error' }; // Indicate balance fetch error
                }
                return { ...acc, balance: balanceData }; // Add the calculated balance
            } catch (rpcErr) {
                 console.error(`RPC Error calculating balance for account ${acc.id}:`, rpcErr);
                 return { ...acc, balance: 'Error' };
            }
        }));


        return { statusCode: 200, body: JSON.stringify(accountsWithBalance) };

    } catch (err) {
        console.error('Unexpected error in handleListAccounts:', err);
        return { statusCode: 500, body: JSON.stringify({ message: `Internal server error: ${err.message}` }) };
    }
}

async function handleGetAccount(req, verifiedToken) {
    // Extract accountId from path (requires path param setup in netlify.toml or function name)
    // Netlify functions pass path params differently depending on setup.
    // Assuming a structure like /api/account-service/accounts/{accountId} routed correctly.
    // We might need to parse event.path carefully. Let's assume it's the last part for now.
    const pathParts = req.path.split('/');
    const accountId = pathParts[pathParts.length - 1];

     if (!accountId || accountId.length < 10) { // Basic check
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing or invalid account ID in path' }) };
    }


    try {
        const { data: accountData, error: accountError } = await supabase
            .from('accounts')
            .select('*') // Select all fields for detail view
            .eq('id', accountId) // Assuming accountId is the UUID primary key
            .single();

        if (accountError) {
             if (accountError.code === 'PGRST116' || accountError.code === '22P02') { // Not found or invalid UUID format
                console.log(`Account not found for ID: ${accountId}`);
                return { statusCode: 404, body: JSON.stringify({ message: 'Account not found' }) };
            }
            console.error('Supabase select error getting account:', accountError);
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error getting account', details: accountError.message }) };
         }
        if (!accountData) {
             console.log(`Account not found for ID: ${accountId}`);
             return { statusCode: 404, body: JSON.stringify({ message: 'Account not found' }) };
        }

        // Authorization check
        const requestingCustomerId = await getCustomerIdFromAuth0Sub(verifiedToken.sub);
        if (!requestingCustomerId || requestingCustomerId !== accountData.customer_id) {
            console.warn(`Auth mismatch: Token sub ${verifiedToken.sub} (customer ${requestingCustomerId}) tried to get account ${accountId} owned by customer ${accountData.customer_id}`);
            return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: You can only view your own accounts.' }) };
         }

        // Fetch balance using RPC
        let balance = 'Error'; // Default in case of error
        try {
             const { data: balanceData, error: balanceError } = await supabase.rpc('calculate_balance', {
                p_account_id: accountData.id // Pass the account UUID
             });

             if (balanceError) {
                 console.error(`Error calculating balance for account ${accountData.id}:`, balanceError);
             } else {
                 balance = balanceData; // Assign the calculated balance
             }
        } catch(rpcErr){
             console.error(`RPC Error calculating balance for account ${accountData.id}:`, rpcErr);
        }

        const accountWithBalance = { ...accountData, balance: balance };

        return { statusCode: 200, body: JSON.stringify(accountWithBalance) };

    } catch (err) {
        console.error('Unexpected error in handleGetAccount:', err);
        return { statusCode: 500, body: JSON.stringify({ message: `Internal server error: ${err.message}` }) };
    }
}


async function handleUpdateAccount(req, verifiedToken) {
     // Extract accountId from path
    const pathParts = req.path.split('/');
    const accountId = pathParts[pathParts.length - 1];

    if (!accountId || accountId.length < 10) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing or invalid account ID in path' }) };
    }

    let requestBody;
    try {
        requestBody = JSON.parse(req.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
    }

    const { status } = requestBody;

    // Basic validation
    if (!status || !['ACTIVE', 'DORMANT', 'PENDING_CLOSURE', 'CLOSED'].includes(status)) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing or invalid status in request body' }) };
    }

    try {
         // 1. Fetch the account to verify ownership first
         const { data: accountData, error: fetchError } = await supabase
            .from('accounts')
            .select('customer_id')
            .eq('id', accountId)
            .single();

         if (fetchError) {
             if (fetchError.code === 'PGRST116' || fetchError.code === '22P02') {
                 return { statusCode: 404, body: JSON.stringify({ message: 'Account not found' }) };
             }
             console.error('Supabase fetch error before update:', fetchError);
             return { statusCode: 500, body: JSON.stringify({ message: 'Database error fetching account', details: fetchError.message }) };
         }
         if (!accountData) { return { statusCode: 404, body: JSON.stringify({ message: 'Account not found' }) }; }


         // Authorization: Ensure the token owner owns this account
         // TODO: In future, check for specific admin roles here too. For now, only owner can update status? Or maybe no one via API? Let's allow owner for now.
         const requestingCustomerId = await getCustomerIdFromAuth0Sub(verifiedToken.sub);
         if (!requestingCustomerId || requestingCustomerId !== accountData.customer_id) {
             console.warn(`Auth mismatch: Token sub ${verifiedToken.sub} (customer ${requestingCustomerId}) tried to update account ${accountId} owned by customer ${accountData.customer_id}`);
             return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: You cannot update this account.' }) };
         }

         // 2. Perform the update
        const { data: updateData, error: updateError } = await supabase
            .from('accounts')
            .update({ status: status })
            .eq('id', accountId)
            .select()
            .single();

        if (updateError) {
            console.error('Supabase update error:', updateError);
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error updating account', details: updateError.message }) };
        }

        console.log(`Account ${accountId} status updated to ${status}`);
        return { statusCode: 200, body: JSON.stringify(updateData) };

    } catch (err) {
        console.error('Unexpected error in handleUpdateAccount:', err);
        return { statusCode: 500, body: JSON.stringify({ message: `Internal server error: ${err.message}` }) };
    }
}


// --- Main Handler ---
exports.handler = async (event, context) => {
    // Ensure environment variables are loaded (important for serverless)
    if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
       return { statusCode: 500, body: JSON.stringify({ message: 'Account Service: Server configuration error: Missing environment variables.' }) };
    }

    const path = event.path.replace('/api/account-service', ''); // Base path for this service
    const method = event.httpMethod;

    console.log(`Account Service Request: ${method} ${path}`);

    try {
        // Verify token first for all routes
        const verifiedToken = await verifyToken(event);
        console.log(`Account Service: Token verified for user: ${verifiedToken.sub}`);

        // Routing Logic
        // Matches POST /accounts
        if (method === 'POST' && /^\/accounts\/?$/.test(path)) {
            return await handleCreateAccount(event, verifiedToken);
        }
        // Matches GET /accounts?customerId=...
        else if (method === 'GET' && /^\/accounts\/?$/.test(path) && event.queryStringParameters?.customerId) {
            return await handleListAccounts(event, verifiedToken);
        }
         // Matches GET /accounts/{accountId} - accountId is UUID
        else if (method === 'GET' && /^\/accounts\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/.test(path)) {
            return await handleGetAccount(event, verifiedToken);
        }
        // Matches PATCH /accounts/{accountId}
        else if (method === 'PATCH' && /^\/accounts\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/.test(path)) {
             return await handleUpdateAccount(event, verifiedToken);
        }
        // Default fallback
        else {
            console.log("Route not matched:", method, path);
            return { statusCode: 404, body: JSON.stringify({ message: 'Account Service: Route not found' }) };
        }

    } catch (error) {
        // Handle errors from verifyToken or unexpected errors
        console.error('Account Service: Unhandled error in main handler:', error);
        const statusCode = error.statusCode || 500;
        const message = error.message || 'Internal Server Error';
        return { statusCode: statusCode, body: JSON.stringify({ message: message }) };
    }
}; 