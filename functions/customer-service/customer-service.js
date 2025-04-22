const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// --- Configuration (fetch from environment variables) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE; // e.g., https://your-auth0-domain.com/

if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
    console.error('Missing required environment variables');
    // In a real app, you might want to prevent the function from even starting
}

// Initialize Supabase client (use service role key for backend operations)
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Initialize JWKS client for Auth0
const jwksRsaClient = jwksClient({
    jwksUri: `https://${auth0Domain}/.well-known/jwks.json`
});

// --- Helper Functions ---

// Function to get the signing key from Auth0
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
        const token = authHeader.substring(7); // Remove 'Bearer '

        jwt.verify(token, getSigningKey, { audience: auth0Audience, issuer: `https://${auth0Domain}/`, algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                console.error('JWT verification error:', err);
                return reject({ statusCode: 401, message: `Token verification failed: ${err.message}` });
            }
            resolve(decoded); // Contains user info like 'sub' (Auth0 user ID)
        });
    });
}

// --- Route Handlers ---

async function handleCreateCustomer(req, verifiedToken) {
    let requestBody;
    try {
        requestBody = JSON.parse(req.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
    }

    const { auth0_user_id, email } = requestBody;

    // Basic validation
    if (!auth0_user_id || !email) {
        return { statusCode: 400, body: JSON.stringify({ message: 'Missing auth0_user_id or email in request body' }) };
    }

    // Ensure the auth0_user_id in the body matches the token subject
    if (auth0_user_id !== verifiedToken.sub) {
        console.warn(`Attempt to create customer with mismatched auth0_user_id. Token sub: ${verifiedToken.sub}, Body ID: ${auth0_user_id}`);
        return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden: User ID mismatch' }) };
    }

    try {
        // Use upsert to either create or do nothing if exists (based on auth0_user_id constraint)
        const { data, error } = await supabase
            .from('customer')
            .upsert({ auth0_user_id: auth0_user_id, email: email }, { onConflict: 'auth0_user_id' })
            .select()
            .single(); // Select the (potentially existing) row

        if (error) {
            console.error('Supabase upsert error:', error);
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error during customer creation', details: error.message }) };
        }

        console.log(`Customer ensured in DB for auth0_user_id: ${auth0_user_id}`);
        // Return 201 if created, 200 if already existed (upsert behavior)
        // For simplicity, let's just return the customer data with 200 OK
        return { statusCode: 200, body: JSON.stringify(data) };

    } catch (err) {
        console.error('Unexpected error in handleCreateCustomer:', err);
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
    }
}

async function handleGetProfile(req, verifiedToken) {
    const auth0UserId = verifiedToken.sub;

    try {
        const { data, error } = await supabase
            .from('customer')
            .select('*')
            .eq('auth0_user_id', auth0UserId)
            .single(); // Expect only one or zero results

        if (error) {
            if (error.code === 'PGRST116') { // PostgREST error code for "Searched for one row but found 0"
                console.log(`Customer profile not found for auth0_user_id: ${auth0UserId}`);
                return { statusCode: 404, body: JSON.stringify({ message: 'Customer profile not found' }) };
            }
            console.error('Supabase select error:', error);
            return { statusCode: 500, body: JSON.stringify({ message: 'Database error fetching profile', details: error.message }) };
        }

        if (!data) {
             // Should be caught by error.code PGRST116, but as a fallback
            console.log(`Customer profile not found for auth0_user_id: ${auth0UserId}`);
            return { statusCode: 404, body: JSON.stringify({ message: 'Customer profile not found' }) };
        }

        return { statusCode: 200, body: JSON.stringify(data) };

    } catch (err) {
        console.error('Unexpected error in handleGetProfile:', err);
        return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
    }
}

// --- Main Handler ---
exports.handler = async (event, context) => {
    // Ensure environment variables are loaded (important for serverless)
    if (!supabaseUrl || !supabaseServiceRoleKey || !auth0Domain || !auth0Audience) {
       return { statusCode: 500, body: JSON.stringify({ message: 'Server configuration error: Missing environment variables.' }) };
    }

    // Simple path-based routing
    const path = event.path.replace('/api/customer-service', '') || '/';
    const method = event.httpMethod;

    console.log(`Received request: ${method} ${path}`);

    try {
        // Verify token for all routes in this service
        const verifiedToken = await verifyToken(event);
        console.log(`Token verified for user: ${verifiedToken.sub}`);

        if (method === 'POST' && path === '/create') {
            return await handleCreateCustomer(event, verifiedToken);
        } else if (method === 'GET' && path === '/profile') {
            return await handleGetProfile(event, verifiedToken);
        } else {
            return { statusCode: 404, body: JSON.stringify({ message: 'Route not found' }) };
        }

    } catch (error) {
        // Handle errors from verifyToken or unexpected errors
        console.error('Unhandled error in main handler:', error);
        const statusCode = error.statusCode || 500;
        const message = error.message || 'Internal Server Error';
        return { statusCode: statusCode, body: JSON.stringify({ message: message }) };
    }
}; 