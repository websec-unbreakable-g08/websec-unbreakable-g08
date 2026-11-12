// Inloggen bij Keycloak met de authorization code flow en PKCE. De SPA is een public client:
// er is geen client secret. De tokens staan enkel in het geheugen van deze pagina, nooit in
// localStorage, sessionStorage of een cookie. Na een herlaad loggen we opnieuw in via Keycloak.

let config;        // { issuer, clientId }, van /config
let tokens = null; // { access, refresh, id, expiresAt }

function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const randomString = (length = 32) => base64url(crypto.getRandomValues(new Uint8Array(length)));
const endpoint = (name) => `${config.issuer}/protocol/openid-connect/${name}`;
const redirectUri = () => location.origin + '/';

// Enkel om de naam te tonen; de API controleert het token zelf.
function claims(jwt) {
    const json = atob(jwt.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, c => c.charCodeAt(0))));
}

async function requestTokens(params) {
    const response = await fetch(endpoint('token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, ...params }),
    });
    if (!response.ok) {
        throw new Error(`Keycloak gaf geen token (${response.status})`);
    }
    const json = await response.json();
    tokens = {
        access: json.access_token,
        refresh: json.refresh_token,
        id: json.id_token ?? tokens?.id,
        expiresAt: Date.now() + json.expires_in * 1000,
    };
}

// Bij het laden: komen we terug van Keycloak met een code, dan ruilen we die in voor tokens.
export async function init() {
    config = await (await fetch('/config')).json();

    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) {
        return;
    }

    // De verifier en state overleven de omweg via Keycloak in sessionStorage, en worden meteen gewist.
    const saved = JSON.parse(sessionStorage.getItem('pkce') || 'null');
    sessionStorage.removeItem('pkce');
    history.replaceState(null, '', '/' + (saved?.returnTo || '#/inbox'));

    if (params.has('error')) {
        throw new Error('Inloggen mislukt: ' + params.get('error'));
    }
    if (!saved || params.get('state') !== saved.state) {
        throw new Error('Inloggen mislukt: het antwoord hoort niet bij deze aanvraag (state)');
    }
    if (params.has('iss') && params.get('iss') !== config.issuer) {
        throw new Error('Inloggen mislukt: het antwoord komt van een onbekende issuer');
    }

    await requestTokens({
        grant_type: 'authorization_code',
        code: params.get('code'),
        redirect_uri: redirectUri(),
        code_verifier: saved.verifier,
    });
}

export async function login() {
    const verifier = randomString();
    const state = randomString(16);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const returnTo = location.hash && location.hash !== '#/' ? location.hash : '#/inbox';
    sessionStorage.setItem('pkce', JSON.stringify({ verifier, state, returnTo }));

    location.assign(endpoint('auth') + '?' + new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        scope: 'openid',
        redirect_uri: redirectUri(),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }));
}

export function logout() {
    const idToken = tokens?.id;
    tokens = null;
    location.assign(endpoint('logout') + '?' + new URLSearchParams({
        client_id: config.clientId,
        post_logout_redirect_uri: redirectUri(),
        ...(idToken && { id_token_hint: idToken }),
    }));
}

export function currentUser() {
    return tokens ? claims(tokens.access).preferred_username : null;
}

// Een geldig access token, vernieuwd vlak voor het verloopt (het leeft 5 minuten).
export async function accessToken() {
    if (tokens && Date.now() > tokens.expiresAt - 30_000) {
        try {
            await requestTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
        } catch {
            tokens = null;
        }
    }
    return tokens?.access ?? null;
}
