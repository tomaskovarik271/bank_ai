document.addEventListener('DOMContentLoaded', async () => {
    let auth0Client = null;

    // --- Auth0 Configuration ---
    const auth0Domain = 'dev-as7b38p8c1wmdva4.us.auth0.com';
    const auth0ClientId = 'BlP00MdAACsYEhcYQBCcfZhsraHFGL1Z';
    const auth0RedirectUri = window.location.origin; // Use current origin for redirect

    // --- UI Elements ---
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const profileBtn = document.getElementById('profileBtn');
    const authButtonsDiv = document.getElementById('auth-buttons');
    const userInfoDiv = document.getElementById('user-info');
    const userNameSpan = document.getElementById('userName');
    const profileDiv = document.getElementById('profile');
    const profileDataPre = document.getElementById('profileData');
    const errorDiv = document.getElementById('error');
    const errorDataPre = document.getElementById('errorData');

    // --- Helper Functions ---
    const showElement = (element) => element.classList.remove('hidden');
    const hideElement = (element) => element.classList.add('hidden');
    const displayError = (message) => {
        errorDataPre.textContent = JSON.stringify(message, null, 2);
        showElement(errorDiv);
        hideElement(profileDiv);
    };
    const clearError = () => {
        hideElement(errorDiv);
        errorDataPre.textContent = '';
    }
    const displayProfile = (data) => {
        profileDataPre.textContent = JSON.stringify(data, null, 2);
        showElement(profileDiv);
        hideElement(errorDiv);
    };
    const clearProfile = () => {
        hideElement(profileDiv);
        profileDataPre.textContent = '';
    }

    // --- Auth0 Initialization ---
    const configureClient = async () => {
        try {
            auth0Client = await auth0.createAuth0Client({
                domain: auth0Domain,
                clientId: auth0ClientId,
                authorizationParams: {
                    redirect_uri: auth0RedirectUri,
                    // Use the custom API audience
                    audience: 'https://api.bank-ai-poc.com'
                }
            });
        } catch (err) {
            console.error("Error configuring Auth0 client:", err);
            displayError({ message: "Auth0 configuration failed.", error: err });
        }
    };

    // --- Update UI based on Auth State ---
    const updateUI = async () => {
        try {
            const isAuthenticated = await auth0Client.isAuthenticated();

            if (isAuthenticated) {
                hideElement(authButtonsDiv);
                showElement(userInfoDiv);
                const user = await auth0Client.getUser();
                userNameSpan.textContent = user?.name || user?.email || 'User';
            } else {
                showElement(authButtonsDiv);
                hideElement(userInfoDiv);
                clearProfile();
            }
            clearError();
        } catch (err) {
            console.error("Error updating UI:", err);
            displayError({ message: "Failed to check authentication status.", error: err });
        }
    };

    // --- Event Listeners ---
    loginBtn.addEventListener('click', async () => {
        clearError();
        clearProfile();
        try {
            await auth0Client.loginWithRedirect();
        } catch (err) {
            console.error("Login failed:", err);
            displayError({ message: "Login failed.", error: err });
        }
    });

    logoutBtn.addEventListener('click', async () => {
        clearError();
        clearProfile();
        try {
            await auth0Client.logout({
                logoutParams: {
                    returnTo: window.location.origin
                }
            });
        } catch (err) {
            console.error("Logout failed:", err);
            displayError({ message: "Logout failed.", error: err });
        }
    });

    profileBtn.addEventListener('click', async () => {
        clearError();
        clearProfile();
        try {
            const isAuthenticated = await auth0Client.isAuthenticated();
            if (!isAuthenticated) {
                displayError({ message: "User not authenticated." });
                return;
            }

            // Get the access token to call the backend
            const accessToken = await auth0Client.getTokenSilently();
            console.log("Access Token obtained:", !!accessToken);

            // Call the backend function
            const response = await fetch('/api/customer-service/profile', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!response.ok) {
                const errorBody = await response.text(); // Get raw response body for debugging
                console.error("API Error Response:", errorBody);
                throw new Error(`API request failed with status ${response.status}. Body: ${errorBody}`);
            }

            const profileData = await response.json();
            displayProfile(profileData);

        } catch (err) {
            console.error("Error getting profile:", err);
            displayError({ message: "Failed to get profile.", error: err.message || err });
        }
    });

    // --- Initialization Logic ---
    await configureClient();

    // Handle the redirect after login
    if (window.location.search.includes('code=') && window.location.search.includes('state=')) {
        try {
            await auth0Client.handleRedirectCallback();
            window.history.replaceState({}, document.title, '/'); // Clean up URL

            // --- Trigger backend customer creation after signup ---
            // We check if the user is newly created by looking at user metadata set by Auth0 Actions/Rules
            // OR simply call our backend every time after redirect for simplicity in this PoC
            const user = await auth0Client.getUser();
            const accessToken = await auth0Client.getTokenSilently();
            if (user && accessToken) {
                try {
                    // TODO: Add logic here to determine if this is the *first* login after signup
                    // For this PoC, we'll just call the creation endpoint every time
                    const createResponse = await fetch('/api/customer-service/create', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ auth0_user_id: user.sub, email: user.email })
                    });
                    if (!createResponse.ok && createResponse.status !== 409) { // Ignore 409 Conflict (already exists)
                        console.warn('Failed to ensure customer exists in backend:', await createResponse.text());
                    }
                } catch (createErr) {
                    console.error('Error calling create customer endpoint:', createErr);
                    // Non-critical for login flow, maybe show a subtle warning
                }
            }

        } catch (err) {
            console.error("Error handling redirect callback:", err);
            displayError({ message: "Failed to handle login redirect.", error: err });
        }
    }

    // Update UI based on initial state
    await updateUI();
}); 