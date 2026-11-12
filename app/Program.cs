using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;
using Unbreakable;
using Unbreakable.Data;
using Unbreakable.Models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<UnbreakableContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Unbreakable")));

builder.Services.AddCors(options =>
    options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

// Inloggen gebeurt bij Keycloak. De API aanvaardt enkel een access token dat Keycloak met RS256
// ondertekende voor deze API: handtekening, issuer, audience en geldigheid worden gecontroleerd.
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
{
    var oidc = builder.Configuration.GetSection("Oidc");

    // De sleutels (JWKS) haalt de API op via het interne netwerk, daarom http.
    // De issuer in het token is de publieke URL van Keycloak.
    options.MetadataAddress = oidc["MetadataAddress"];
    options.RequireHttpsMetadata = false;
    options.MapInboundClaims = false;
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidIssuer = oidc["Issuer"],
        ValidAudience = oidc["Audience"],
        ValidAlgorithms = new[] { SecurityAlgorithms.RsaSha256 },
        NameClaimType = "preferred_username",
        ClockSkew = TimeSpan.FromSeconds(30)
    };
});
builder.Services.AddAuthorization();
builder.Services.AddSingleton<Fga>();

var app = builder.Build();

// Databank aanmaken en vullen met voorbeeldberichten, en OpenFGA klaarzetten.
// Die kunnen iets later opstarten dan de app, dus we proberen een paar keer. Lukt het niet,
// dan stopt de app: zonder OpenFGA mag ze geen berichten tonen.
using (var scope = app.Services.CreateScope())
{
    var context = scope.ServiceProvider.GetRequiredService<UnbreakableContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    for (var attempt = 1; attempt <= 30; attempt++)
    {
        try
        {
            context.Database.EnsureCreated();
            SeedData.Initialize(context);

            // Eenmalig: Keycloak kent gebruikersnamen enkel in kleine letters, oudere berichten hadden "Anna".
            context.Database.ExecuteSqlRaw(
                "UPDATE \"Messages\" SET \"Sender\" = lower(\"Sender\"), \"Recipient\" = lower(\"Recipient\") " +
                "WHERE \"Sender\" <> lower(\"Sender\") OR \"Recipient\" <> lower(\"Recipient\")");

            app.Services.GetRequiredService<Fga>()
                .InitializeAsync(app.Configuration["OpenFga:ModelPath"], context.Messages.AsNoTracking().ToList())
                .GetAwaiter().GetResult();
            break;
        }
        catch (Exception ex) when (attempt < 30)
        {
            logger.LogWarning("Databank of OpenFGA nog niet bereikbaar ({Error}), poging {Attempt}", ex.Message, attempt);
            Thread.Sleep(2000);
        }
    }
}

app.UseDeveloperExceptionPage();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

// De SPA: index.html, JavaScript en CSS uit wwwroot.
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // De browser moet bij elke aanvraag nagaan of een bestand gewijzigd is (ETag). Anders blijft hij
    // na een update een oude versie van de SPA gebruiken, bijvoorbeeld een api.js zonder token.
    OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
});

app.MapGet("/health", () => "ok");

// Wat de SPA nodig heeft om bij Keycloak in te loggen. Geen geheimen: de SPA is een public client.
app.MapGet("/config", (IConfiguration configuration) => Results.Json(new
{
    issuer = configuration["Oidc:Issuer"],
    clientId = configuration["Oidc:ClientId"]
}));

// De API. Wie je bent, staat in het token van Keycloak (claim preferred_username).
var api = app.MapGroup("/api")
    .RequireAuthorization(policy => policy.RequireAuthenticatedUser().RequireClaim("preferred_username"));

// Fail closed: geeft OpenFGA geen antwoord, dan weigert de API in plaats van te gokken.
api.AddEndpointFilter(async (context, next) =>
{
    try
    {
        return await next(context);
    }
    catch (FgaUnavailableException error)
    {
        app.Logger.LogError(error, "OpenFGA gaf geen antwoord, aanvraag geweigerd");
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});

api.MapGet("/users", async (UnbreakableContext db) =>
{
    var senders = await db.Messages.Select(m => m.Sender).Distinct().ToListAsync();
    var recipients = await db.Messages.Select(m => m.Recipient).Distinct().ToListAsync();
    return Results.Ok(senders.Union(recipients).OrderBy(name => name).ToList());
});

api.MapGet("/messages", async (ClaimsPrincipal principal, HttpRequest request, UnbreakableContext db) =>
{
    var user = principal.Identity.Name;

    var inbox = db.Messages.Where(m => m.Recipient == user);

    var from = request.Query["from"].ToString();
    if (!string.IsNullOrEmpty(from))
    {
        inbox = inbox.Where(m => m.Sender == from);
    }

    return Results.Ok(await inbox.OrderByDescending(m => m.SentAt).ToListAsync());
});

api.MapGet("/messages/search", async (ClaimsPrincipal principal, HttpRequest request, UnbreakableContext db) =>
{
    var user = principal.Identity.Name;

    var q = request.Query["q"].ToString();
    var sql = "SELECT * FROM \"Messages\" WHERE \"Recipient\" = '" + user + "' " +
              "AND (\"Subject\" ILIKE '%" + q + "%' OR \"Body\" ILIKE '%" + q + "%')";

    var messages = await db.Messages.FromSqlRaw(sql).OrderByDescending(m => m.SentAt).ToListAsync();
    return Results.Ok(messages);
});

api.MapGet("/messages/export", async (ClaimsPrincipal principal, UnbreakableContext db) =>
{
    var user = principal.Identity.Name;

    var messages = await db.Messages
        .Where(m => m.Recipient == user)
        .OrderBy(m => m.SentAt)
        .ToListAsync();

    return Results.Text(JsonConvert.SerializeObject(messages, Formatting.Indented), "application/json");
});

// Niet toegestaan en onbestaand geven hetzelfde antwoord: zo verklapt de API niet welke berichten bestaan.
api.MapGet("/messages/{id:int}", async (int id, ClaimsPrincipal principal, Fga fga, UnbreakableContext db) =>
{
    if (!await fga.CanAsync(principal.Identity.Name, "can_read", id))
    {
        return Results.NotFound();
    }

    var message = await db.Messages.FindAsync(id);
    return message == null ? Results.NotFound() : Results.Ok(message);
});

api.MapPost("/messages", async (Message message, ClaimsPrincipal principal, Fga fga, UnbreakableContext db) =>
{
    // De afzender komt uit het token, nooit uit wat de client meestuurt.
    message.Sender = principal.Identity.Name;
    message.Recipient = message.Recipient?.Trim().ToLowerInvariant() ?? "";
    if (!Regex.IsMatch(message.Recipient, "^[a-z0-9._-]{2,40}$"))
    {
        return Results.BadRequest("Ongeldige ontvanger.");
    }

    message.Id = 0;
    message.SentAt = DateTime.UtcNow;

    db.Messages.Add(message);
    await db.SaveChangesAsync();

    // Wie afzender en ontvanger is, staat vanaf nu in OpenFGA. Lukt dat niet, dan bestaat het bericht niet.
    try
    {
        await fga.AddAsync(message);
    }
    catch (FgaUnavailableException)
    {
        db.Messages.Remove(message);
        await db.SaveChangesAsync();
        throw;
    }

    return Results.Created($"/api/messages/{message.Id}", message);
});

api.MapDelete("/messages/{id:int}", async (int id, ClaimsPrincipal principal, Fga fga, UnbreakableContext db) =>
{
    if (!await fga.CanAsync(principal.Identity.Name, "can_delete", id))
    {
        return Results.NotFound();
    }

    var message = await db.Messages.FindAsync(id);
    if (message == null)
    {
        return Results.NotFound();
    }

    db.Messages.Remove(message);
    await db.SaveChangesAsync();
    await fga.RemoveAsync(message);
    return Results.NoContent();
});

app.Run();
