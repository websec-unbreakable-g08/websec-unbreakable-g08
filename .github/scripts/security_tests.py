#!/usr/bin/env python3
"""Beveiligingstests op het GEDRAG van de draaiende app.

Statische scans zien codepatronen, maar geen autorisatiefouten: of iemand een bericht
van een ander mag lezen of verwijderen, hangt af van wat de app doet, niet van hoe de
code eruitziet. Daarom start de pipeline de app en probeert dit script het misbruik echt.

Het script logt in zoals de SPA dat doet: bij Keycloak, met de authorization code flow
en PKCE. Zo test het de echte weg en hoeft de realm geen zwakkere login (wachtwoord
rechtstreeks naar het token-endpoint) toe te laten enkel voor de tests. De testgebruikers
anna, bram en chris en hun wachtwoorden komen uit het .env-bestand.

Elke test beschrijft een beveiligingseis. Gedraagt de app zich anders dan de eis, dan
is dat een bevinding. De bevindingen gaan als JSON naar de poort (security_gate.py),
die ze net zo behandelt als de andere scans: nieuwe bevindingen laten de pipeline
falen, aanvaarde (met reden) niet.

Het script faalt gesloten: start de app niet, lukt inloggen niet of mislukt een
voorbereiding, dan stopt het met exitcode 2. Een test die niet kon draaien is geen
bewijs van veiligheid.

Met --token <gebruiker> drukt het enkel een access token af, handig voor curl.

Enkel standaardbibliotheek.
"""
import argparse
import base64
import hashlib
import html
import http.cookiejar
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def call(base, method, path, token=None, body=None, headers=None):
    headers = dict(headers or {})
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def fail_closed(msg):
    print(f"::error::{msg}")
    sys.exit(2)


def wait_ready(url, what, expect=None):
    for _ in range(90):
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status == 200 and (expect is None or resp.read().decode().strip() == expect):
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(2)
    fail_closed(f"{what} werd niet bereikbaar op {url}: de tests konden niet draaien")


def read_env(path):
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [line.strip() for line in fh]
    except OSError as err:
        fail_closed(f"Kan {path} niet lezen ({err}): de testgebruikers zijn niet gekend")
    return dict(line.split("=", 1) for line in lines if "=" in line and not line.startswith("#"))


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def login(oidc, redirect_uri, user, password):
    """Authorization code flow met PKCE. Geeft het access token terug."""
    # Keycloak zet zijn cookies ook op http://localhost als Secure, omdat browsers localhost als
    # veilig beschouwen. Python stuurt Secure-cookies standaard enkel over https terug; voor
    # localhost (lokaal en in de pipeline) doen we hier wat een browser doet.
    local = urllib.parse.urlparse(oidc["issuer"]).hostname in ("localhost", "127.0.0.1", "::1")
    policy = http.cookiejar.DefaultCookiePolicy(secure_protocols=("https", "wss") + (("http",) if local else ()))
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar(policy)), NoRedirect)
    endpoint = oidc["issuer"] + "/protocol/openid-connect/"
    verifier = b64url(secrets.token_bytes(32))
    state = secrets.token_urlsafe(8)
    query = urllib.parse.urlencode({
        "client_id": oidc["clientId"], "response_type": "code", "scope": "openid",
        "redirect_uri": redirect_uri, "state": state,
        "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
    })
    try:
        page = opener.open(endpoint + "auth?" + query, timeout=15).read().decode()
        form = re.search(r'<form[^>]*action="([^"]+)"', page)
        if not form:
            fail_closed("Keycloak toonde geen loginformulier")
        credentials = urllib.parse.urlencode({"username": user, "password": password}).encode()
        try:
            opener.open(html.unescape(form.group(1)), data=credentials, timeout=15)
            fail_closed(f"Inloggen als {user} mislukt: Keycloak stuurde niet terug naar de app")
        except urllib.error.HTTPError as redirect:
            target = urllib.parse.urlparse(redirect.headers.get("Location", ""))
            answer = urllib.parse.parse_qs(target.query)
        if answer.get("state") != [state] or "code" not in answer:
            fail_closed(f"Inloggen als {user} mislukt: geen code in het antwoord van Keycloak "
                        f"(HTTP {redirect.code}, doorverwezen naar '{target.path}')")
        body = urllib.parse.urlencode({
            "grant_type": "authorization_code", "client_id": oidc["clientId"],
            "code": answer["code"][0], "redirect_uri": redirect_uri, "code_verifier": verifier,
        }).encode()
        return json.load(opener.open(endpoint + "token", data=body, timeout=15))["access_token"]
    except (urllib.error.URLError, ConnectionError, OSError, ValueError, KeyError) as err:
        fail_closed(f"Inloggen als {user} mislukt: {err}")


def create_message(base, token, recipient):
    status, body = call(base, "POST", "/api/messages", token=token, body={
        "recipient": recipient, "subject": "beveiligingstest", "body": "testbericht, mag verwijderd worden",
    })
    if status not in (200, 201):
        fail_closed(f"Voorbereiding mislukt: POST /api/messages gaf {status}")
    try:
        return json.loads(body)["id"]
    except (ValueError, KeyError, TypeError):
        fail_closed("Voorbereiding mislukt: geen id in het antwoord van POST /api/messages")


def run_tests(base, tokens):
    findings = []
    anna, bram, chris = tokens["anna"], tokens["bram"], tokens["chris"]

    def finding(fid, endpoint, title, expected, actual):
        findings.append({"id": fid, "endpoint": endpoint, "title": title,
                         "expected": expected, "actual": str(actual), "severity": "high"})

    # 1. Identiteit zonder bewijs: de vroegere X-User-header mag niets meer opleveren
    status, _ = call(base, "GET", "/api/messages", headers={"X-User": "bram"})
    if status == 200:
        finding("identity-without-credential", "GET /api/messages",
                "Iedereen kan zich voordoen als een willekeurige gebruiker door een header mee te sturen",
                "401 of 403 zonder wachtwoord of token", status)

    # 2. Een token zonder geldige handtekening (alg none, inhoud van een echt token)
    payload = anna.split(".")[1]
    unsigned = b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode()) + "." + payload + "."
    status, _ = call(base, "GET", "/api/messages", token=unsigned)
    if status == 200:
        finding("unsigned-token-accepted", "GET /api/messages",
                "De API aanvaardt een token zonder handtekening (alg none)", "401", status)

    # 3. De afzender komt uit het token, niet uit wat de client meestuurt
    status, body = call(base, "POST", "/api/messages", token=anna, body={
        "sender": "bram", "recipient": "chris", "subject": "beveiligingstest", "body": "testbericht"})
    if status in (200, 201):
        spoofed = json.loads(body)
        if spoofed.get("sender") != "anna":
            finding("sender-spoofing", "POST /api/messages",
                    "Een gebruiker kan een bericht versturen op naam van iemand anders",
                    "afzender anna (uit het token)", spoofed.get("sender"))
        call(base, "DELETE", f"/api/messages/{spoofed.get('id')}", token=anna)
    else:
        fail_closed(f"Voorbereiding mislukt: POST /api/messages gaf {status}")

    # Het testbericht: van anna aan bram. Chris is de derde die er niets mee te maken heeft.
    mid = create_message(base, anna, "bram")
    status, _ = call(base, "GET", f"/api/messages/{mid}", token=bram)
    if status != 200:
        fail_closed(f"De ontvanger kan zijn eigen bericht niet lezen ({status}): de tests bewijzen dan niets")

    # 4. Bericht van een ander lezen
    status, _ = call(base, "GET", f"/api/messages/{mid}", token=chris)
    if status == 200:
        finding("idor-read-foreign-message", "GET /api/messages/{id}",
                "Een derde die geen afzender of ontvanger is, kan het bericht lezen",
                "403 of 404", status)
    status, body = call(base, "GET", "/api/messages", token=chris)
    if status == 200 and any(m.get("id") == mid for m in json.loads(body)):
        finding("foreign-message-in-inbox", "GET /api/messages",
                "Een bericht voor iemand anders staat in de inbox van een derde", "niet in de lijst", "in de lijst")

    # 5. Verwijderen zonder identiteit
    status, _ = call(base, "DELETE", f"/api/messages/{mid}")
    if status in (200, 204):
        finding("delete-without-identity", "DELETE /api/messages/{id}",
                "Een bericht kan verwijderd worden zonder dat de aanvrager zich bekendmaakt",
                "401 of 403", status)

    # 6. Bericht van een ander verwijderen
    status, _ = call(base, "DELETE", f"/api/messages/{mid}", token=chris)
    if status in (200, 204):
        finding("delete-foreign-message", "DELETE /api/messages/{id}",
                "Een derde die geen afzender of ontvanger is, kan het bericht verwijderen",
                "403 of 404", status)

    # Het bericht moet er nog zijn, en de afzender moet het wel kunnen opruimen.
    status, _ = call(base, "GET", f"/api/messages/{mid}", token=bram)
    if status != 200 and not any(f["id"].startswith("delete-") for f in findings):
        fail_closed(f"Het testbericht is verdwenen zonder geslaagde verwijdering ({status})")
    status, _ = call(base, "DELETE", f"/api/messages/{mid}", token=anna)
    if status not in (200, 204) and not any(f["id"].startswith("delete-") for f in findings):
        fail_closed(f"De afzender kan zijn eigen bericht niet verwijderen ({status}): de tests bewijzen dan niets")

    return findings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8080")
    ap.add_argument("--env-file", default=".env", help="bestand met APP_URL en de wachtwoorden van de testgebruikers")
    ap.add_argument("--output", default="tests.json")
    ap.add_argument("--token", metavar="GEBRUIKER", help="druk enkel een access token van deze gebruiker af")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")
    env = read_env(args.env_file)
    wait_ready(base + "/health", "De app", expect="ok")
    oidc = json.loads(call(base, "GET", "/config")[1])
    wait_ready(oidc["issuer"] + "/.well-known/openid-configuration", "Keycloak")

    def token_for(user):
        password = env.get(user.upper() + "_PASSWORD")
        if not password or "APP_URL" not in env:
            fail_closed(f"APP_URL of {user.upper()}_PASSWORD ontbreekt in {args.env_file}")
        return login(oidc, env["APP_URL"].rstrip("/") + "/", user, password)

    if args.token:
        print(token_for(args.token))
        return

    findings = run_tests(base, {user: token_for(user) for user in ("anna", "bram", "chris")})

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump({"base_url": base, "findings": findings, "skipped": []}, fh, indent=2)

    for f in findings:
        print(f"BEVINDING {f['id']}: {f['title']} (verwacht {f['expected']}, kreeg {f['actual']})")
    print(f"{len(findings)} bevinding(en)")


if __name__ == "__main__":
    main()
