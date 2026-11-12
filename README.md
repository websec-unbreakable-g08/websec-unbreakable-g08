# Unbreakable

Starter app voor het vak Cyber Security Advanced aan AP Hogeschool.

Unbreakable is een kleine berichtenapp. Je kiest een naam, je stuurt berichten naar anderen en je leest je inbox. De app werkt, maar is nog helemaal niet veilig. Doorheen het semester maken jullie ze beter: een pipeline en een WAF, cryptografie, inloggen, autorisatie en geheimenbeheer.

> **Let op:** deze app bevat bewust zwakke plekken. Gebruik ze enkel in je eigen labomgeving en nooit met echte gegevens.

## Starten

Je hebt enkel Docker nodig, met de compose plugin.

```bash
git clone <jouw repo>
cd <jouw repo>
cp .env.example .env        # vul eigen wachtwoorden in, .env komt nooit in git
docker network create websec-unbreakable-g08_default
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --build
```

Surf daarna naar `http://localhost:8080` en klik op **Inloggen**. Je logt in bij Keycloak (`http://localhost:8081/auth`) als **anna**, **bram** of **chris**, met het wachtwoord uit je `.env`: die hebben al berichten.

Op de server staat BunkerWeb ervoor (`bunkerweb/docker-compose.yml`) en zijn er geen poorten open: daar volstaat `docker compose up -d --build`, met de publieke URL's in het bestand met geheimen.

Stoppen doe je met `docker compose down`. Wil je opnieuw beginnen met een lege databank, gebruik dan `docker compose down -v`.

Leeft de app? `curl http://localhost:8080/health` geeft `ok`.

## Opbouw

De app bestaat uit twee delen in één container: een single page app (SPA) die in je browser draait, en een API op de server. De SPA praat met de API in JSON. Open de developer tools van je browser (tabblad Network) om te zien wat er over en weer gaat.

```
docker-compose.yml          de app, Keycloak, OpenFGA en hun PostgreSQL databanken
.env.example                welke instellingen en geheimen nodig zijn, zonder echte waarden
keycloak/                   de realm van Keycloak: client, gebruikers
openfga/model.json          het autorisatiemodel
app/
  Program.cs                de API, en opstarten van de databank
  Models/Message.cs         een bericht
  Data/                     databanktoegang (Entity Framework Core)
  wwwroot/                  de SPA
    index.html
    js/app.js               de schermen
    js/api.js               alle calls naar de API
    js/auth.js              inloggen bij Keycloak (authorization code flow met PKCE)
    lib/                    Bootstrap en jQuery
docs/threat-model.md        basis threat model van de starter app
```

### De API

| Methode | Pad | Doet |
|---|---|---|
| GET | `/health` | leeft de app? |
| GET | `/config` | waar de SPA moet inloggen (issuer en client id) |
| GET | `/api/users` | alle gekende namen |
| GET | `/api/messages` | je inbox, optioneel `?from=<naam>` |
| GET | `/api/messages/search?q=<tekst>` | zoeken in je inbox |
| GET | `/api/messages/{id}` | één bericht |
| POST | `/api/messages` | bericht versturen |
| DELETE | `/api/messages/{id}` | bericht verwijderen |
| GET | `/api/messages/export` | je inbox als JSON |

Alles onder `/api` vraagt een access token van Keycloak in de header `Authorization: Bearer <token>`. De API controleert de handtekening (RS256), de issuer, de audience `unbreakable-api` en de geldigheid, en leest wie je bent uit de claim `preferred_username`. Zonder geldig token krijg je `401`.

Technologie: ASP.NET Core minimal API op .NET 10, Entity Framework Core met PostgreSQL 17, en vanilla JavaScript met Bootstrap, zonder build stap.

## Herkomst

Gebaseerd op [websec-vulnerable-dotnetcore](https://github.com/Splynter-Security/websec-vulnerable-dotnetcore), omgebouwd tot een berichtenapp met een SPA en een API, en bijgewerkt naar .NET 10.
