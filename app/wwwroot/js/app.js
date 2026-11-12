// De schermen van Unbreakable. Navigeren gebeurt met het deel na # in de URL.

import { api } from './api.js';
import { init, login, logout, currentUser } from './auth.js';
import { sealMessage, openMessage, parsePayload, IntegrityError } from './crypto.js';

const app = document.getElementById('app');

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatDate(value) {
    return new Date(value).toLocaleString('nl-BE', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function showWho() {
    const user = currentUser();
    document.getElementById('who').innerHTML = user
        ? `Je bent <strong>${escapeHtml(user)}</strong> (<a href="#" id="logout">uitloggen</a>)`
        : '';
    document.getElementById('logout')?.addEventListener('click', (event) => {
        event.preventDefault();
        logout();
    });
}

// ------------------------------------------------------------------ startpagina

function renderLogin() {
    const user = currentUser();
    app.innerHTML = `
        <div class="text-center mb-5">
            <h1 class="display-4">Unbreakable</h1>
            <p class="lead">Berichten die niemand anders kan lezen. Dat is toch de bedoeling.</p>
        </div>
        <div class="text-center">
            ${user
                ? `<p>Je bent ingelogd als <strong>${escapeHtml(user)}</strong>. <a href="#/inbox">Naar je inbox</a></p>`
                : '<button id="login" class="btn btn-primary">Inloggen</button>'}
        </div>`;

    document.getElementById('login')?.addEventListener('click', () => login());
}

// ------------------------------------------------------------------ inbox

async function renderInbox(params) {
    const user = currentUser();
    const q = params.get('q') || '';
    const from = params.get('from') || '';

    const all = await api.inbox();
    const senders = [...new Set(all.map(m => m.sender))].sort();
    const found = q ? await api.search(q) : all;
    const messages = found.filter(m => !from || m.sender === from);

    app.innerHTML = `
        <h1>Inbox van ${escapeHtml(user)}</h1>
        <p>
            <a href="#/nieuw" class="btn btn-primary">Nieuw bericht</a>
            <button id="export" class="btn btn-outline-secondary">Exporteer als JSON</button>
        </p>
        <form id="filter" class="mb-3">
            <div class="form-row align-items-end">
                <div class="col-auto">
                    <label for="from">Van</label>
                    <select id="from" class="form-control">
                        <option value="">Iedereen</option>
                        ${senders.map(s => `<option value="${escapeHtml(s)}" ${s === from ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                    </select>
                </div>
                <div class="col-auto">
                    <label for="q">Zoeken</label>
                    <input id="q" class="form-control" value="${escapeHtml(q)}" />
                </div>
                <div class="col-auto">
                    <button type="submit" class="btn btn-secondary">Filter</button>
                </div>
            </div>
        </form>
        <p id="searched"></p>
        <div id="list"></div>`;

    if (q) {
        window.jQuery('#searched').html('Je zocht naar: ' + q);
    }

    const rows = messages.map(m => `
        <tr>
            <td>${escapeHtml(m.sender)}</td>
            <td><a href="#/bericht/${m.id}">${m.subject}</a></td>
            <td>${formatDate(m.sentAt)}</td>
        </tr>`).join('');

    document.getElementById('list').innerHTML = messages.length
        ? `<table class="table">
               <thead><tr><th>Van</th><th>Onderwerp</th><th>Verzonden</th></tr></thead>
               <tbody>${rows}</tbody>
           </table>`
        : '<p class="text-muted">Geen berichten.</p>';

    document.getElementById('filter').addEventListener('submit', (event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        const newQ = document.getElementById('q').value;
        const newFrom = document.getElementById('from').value;
        if (newQ) next.set('q', newQ);
        if (newFrom) next.set('from', newFrom);
        location.hash = '#/inbox' + (next.toString() ? '?' + next.toString() : '');
    });

    document.getElementById('export').addEventListener('click', async () => {
        const data = await api.exportJson();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'inbox.json';
        link.click();
        URL.revokeObjectURL(link.href);
    });
}

// ------------------------------------------------------------------ bericht lezen

async function renderMessage(id) {
    const m = await api.message(id);
    const payload = parsePayload(m.body);

    app.innerHTML = `
        <h1>${m.subject}</h1>
        <dl class="row">
            <dt class="col-sm-2">Van</dt><dd class="col-sm-10">${escapeHtml(m.sender)}</dd>
            <dt class="col-sm-2">Aan</dt><dd class="col-sm-10">${escapeHtml(m.recipient)}</dd>
            <dt class="col-sm-2">Verzonden</dt><dd class="col-sm-10">${formatDate(m.sentAt)}</dd>
        </dl>
        <div class="card mb-3"><div class="card-body message-body" id="body"></div></div>
        ${payload ? `
        <form id="decrypt" class="mb-3">
            <p class="text-muted">Versleuteld met lijn ${payload.line} van het codeboek.</p>
            <div class="form-group">
                <label for="key">Sleutel (lijn ${payload.line} uit het codeboek)</label>
                <input id="key" class="form-control" autocomplete="off" required />
            </div>
            <div class="form-group">
                <label for="hmac">HMAC-sleutel</label>
                <input id="hmac" type="password" class="form-control" autocomplete="off" required />
            </div>
            <button type="submit" class="btn btn-primary">Controleer en ontsleutel</button>
        </form>
        <div id="result"></div>` : ''}
        <p>
            <button id="delete" class="btn btn-outline-danger">Verwijderen</button>
            <a href="#/inbox" class="btn btn-link">Terug naar je inbox</a>
        </p>`;

    const body = document.getElementById('body');

    if (payload) {
        // Dit is wat de server en de databank zien.
        body.textContent = `[versleuteld] lijn ${payload.line} | ${payload.ct} | mac ${payload.mac}`;

        document.getElementById('decrypt').addEventListener('submit', async (event) => {
            event.preventDefault();
            const result = document.getElementById('result');
            result.innerHTML = '';
            try {
                const plain = await openMessage({
                    payload,
                    key: document.getElementById('key').value,
                    hmacSecret: document.getElementById('hmac').value,
                });
                body.textContent = plain;
            } catch (error) {
                const kind = error instanceof IntegrityError ? 'alert-danger' : 'alert-warning';
                result.innerHTML = `<div class="alert ${kind}">${escapeHtml(error.message)}</div>`;
            }
        });
    } else {
        // Een oud bericht uit de startdata: geen ciphertext.
        body.textContent = m.body;
    }

    document.getElementById('delete').addEventListener('click', async () => {
        if (confirm('Ben je zeker dat je dit bericht wil verwijderen?')) {
            await api.remove(id);
            location.hash = '#/inbox';
        }
    });
}

// ------------------------------------------------------------------ bericht versturen

async function renderNew() {
    const users = await api.users();

    app.innerHTML = `
        <h1>Nieuw bericht</h1>
        <p class="text-muted">Van: ${escapeHtml(currentUser())}. Het bericht wordt in je browser versleuteld.</p>
        <div class="row">
            <div class="col-md-8">
                <form id="compose">
                    <div class="form-group">
                        <label for="recipient">Aan</label>
                        <input id="recipient" class="form-control" list="known-users" autocomplete="off"
                               required minlength="2" maxlength="40" />
                        <datalist id="known-users">
                            ${users.map(u => `<option value="${escapeHtml(u)}"></option>`).join('')}
                        </datalist>
                    </div>
                    <div class="form-group">
                        <label for="text">Bericht (A-Z, 0-9 en spatie, niet langer dan de sleutel)</label>
                        <textarea id="text" class="form-control" rows="3" required maxlength="2000"></textarea>
                    </div>
                    <div class="form-group">
                        <label for="line">Lijnnummer in het codeboek</label>
                        <input id="line" type="number" min="1" step="1" class="form-control" required />
                    </div>
                    <div class="form-group">
                        <label for="key">Sleutel (die lijn uit het codeboek)</label>
                        <input id="key" class="form-control" autocomplete="off" required />
                    </div>
                    <div class="form-group">
                        <label for="hmac">HMAC-sleutel (los van de sleutel hierboven)</label>
                        <input id="hmac" type="password" class="form-control" autocomplete="off" required />
                    </div>
                    <div id="error"></div>
                    <button type="submit" class="btn btn-primary">Versleutel en verstuur</button>
                    <a href="#/inbox" class="btn btn-link">Annuleren</a>
                </form>
            </div>
        </div>`;

    document.getElementById('compose').addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = document.getElementById('error');
        error.innerHTML = '';
        try {
            const body = await sealMessage({
                message: document.getElementById('text').value,
                key: document.getElementById('key').value,
                line: Number(document.getElementById('line').value),
                hmacSecret: document.getElementById('hmac').value,
            });
            await api.send({
                recipient: document.getElementById('recipient').value.trim(),
                subject: 'Versleuteld bericht',
                body,
            });
            location.hash = '#/inbox';
        } catch (e) {
            error.innerHTML = `<div class="alert alert-warning">${escapeHtml(e.message)}</div>`;
        }
    });
}

// ------------------------------------------------------------------ over

function renderAbout() {
    app.innerHTML = `
        <h1>Over Unbreakable</h1>
        <p>Unbreakable is een berichtenapp. Je stuurt een bericht naar iemand, en enkel die persoon kan het lezen.
           Dat is tenminste het doel.</p>
        <p>Deze versie is de starter app van het vak Cyber Security Advanced aan AP Hogeschool.
           Ze werkt, maar is nog helemaal niet veilig. Doorheen het semester maken jullie ze beter.</p>
        <p>De app bestaat uit twee delen: deze single page app in je browser, en een API op de server.
           Bekijk de developer tools van je browser om te zien wat er over en weer gaat.</p>
        <p class="text-danger">Gebruik deze app enkel in je eigen labomgeving en nooit met echte gegevens.</p>`;
}

// ------------------------------------------------------------------ navigatie

async function route() {
    showWho();

    const [path, query] = (location.hash || '#/').slice(1).split('?');
    const params = new URLSearchParams(query || '');

    try {
        if (path === '/' || path === '') {
            return renderLogin();
        }
        if (path === '/over') {
            return renderAbout();
        }
        if (!currentUser()) {
            return await login();
        }
        if (path === '/inbox') {
            return await renderInbox(params);
        }
        if (path === '/nieuw') {
            return await renderNew();
        }
        const match = path.match(/^\/bericht\/(\d+)$/);
        if (match) {
            return await renderMessage(match[1]);
        }
        app.innerHTML = '<p>Deze pagina bestaat niet.</p>';
    } catch (error) {
        app.innerHTML = `<div class="alert alert-danger">Er liep iets mis: ${escapeHtml(error.message)}</div>`;
    }
}

window.addEventListener('hashchange', route);
init().then(route, (error) => {
    showWho();
    app.innerHTML = `<div class="alert alert-danger">${escapeHtml(error.message)}</div>
        <button id="login" class="btn btn-primary">Opnieuw inloggen</button>`;
    document.getElementById('login').addEventListener('click', () => login());
});
