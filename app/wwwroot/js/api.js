// Praat met de API. Alles wat de SPA weet, komt van hier.
// Elke aanvraag draagt het access token van Keycloak mee; wie je bent, bepaalt de API uit dat token.

import { accessToken, login } from './auth.js';

async function call(method, path, body) {
    const token = await accessToken();
    if (!token) {
        await login();
        throw new Error('Je wordt doorgestuurd om in te loggen.');
    }

    const headers = { Authorization: 'Bearer ' + token };
    const options = { method, headers };

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch('/api' + path, options);
    if (response.status === 401) {
        await login();
        throw new Error('Je sessie is verlopen, je wordt doorgestuurd om opnieuw in te loggen.');
    }
    if (!response.ok) {
        throw new Error(`${method} ${path} gaf ${response.status}`);
    }

    const type = response.headers.get('Content-Type') || '';
    return type.includes('application/json') ? response.json() : response.text();
}

export const api = {
    users: () => call('GET', '/users'),
    inbox: (from) => call('GET', '/messages' + (from ? '?from=' + encodeURIComponent(from) : '')),
    search: (q) => call('GET', '/messages/search?q=' + encodeURIComponent(q)),
    message: (id) => call('GET', '/messages/' + id),
    send: (message) => call('POST', '/messages', message),
    remove: (id) => call('DELETE', '/messages/' + id),
    exportJson: () => call('GET', '/messages/export'),
};
