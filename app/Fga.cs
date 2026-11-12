using OpenFga.Sdk.Client;
using OpenFga.Sdk.Client.Model;
using OpenFga.Sdk.Configuration;
using OpenFga.Sdk.Exceptions;
using Unbreakable.Models;

namespace Unbreakable;

// OpenFGA gaf geen bruikbaar antwoord. De API weigert dan (503): geen antwoord is geen toestemming.
public class FgaUnavailableException : Exception
{
    public FgaUnavailableException(Exception inner) : base("OpenFGA gaf geen antwoord", inner) { }
}

// OpenFGA beslist wie wat mag met een bericht (policy decision point). De API stelt enkel de
// vraag en voert het antwoord uit. Het model staat in openfga/model.json.
public class Fga
{
    private const string StoreName = "unbreakable";

    private static readonly ClientWriteOptions IgnoreConflicts = new()
    {
        Conflict = new ConflictOptions
        {
            OnDuplicateWrites = OnDuplicateWrites.Ignore,
            OnMissingDeletes = OnMissingDeletes.Ignore
        }
    };

    private readonly OpenFgaClient _client;
    private readonly ILogger<Fga> _logger;

    public Fga(IConfiguration configuration, ILogger<Fga> logger)
    {
        _logger = logger;
        // Korte time-out en één herkansing: is OpenFGA weg, dan weigert de API binnen enkele seconden
        // in plaats van de aanvraag te laten hangen.
        _client = new OpenFgaClient(new ClientConfiguration
        {
            ApiUrl = configuration["OpenFga:ApiUrl"],
            MaxRetry = 1,
            Credentials = new Credentials
            {
                Method = CredentialsMethod.ApiToken,
                Config = new CredentialsConfig { ApiToken = configuration["OpenFga:ApiKey"] }
            }
        }, new HttpClient { Timeout = TimeSpan.FromSeconds(2) });
    }

    // Bij het opstarten: store zoeken of aanmaken, het model uit de repo laden en de relaties van
    // berichten die al in de databank staan (startdata, berichten van voor OpenFGA) aanvullen.
    public async Task InitializeAsync(string modelPath, IEnumerable<Message> messages)
    {
        var stores = await _client.ListStores(new ClientListStoresRequest { Name = StoreName });
        var store = stores.Stores.FirstOrDefault(s => s.Name == StoreName);
        _client.StoreId = store?.Id ?? (await _client.CreateStore(new ClientCreateStoreRequest { Name = StoreName })).Id;

        // shortcut: elke herstart schrijft een nieuwe, identieke modelversie; vergelijk met het
        // laatste model zodra het aantal versies stoort.
        var model = ClientWriteAuthorizationModelRequest.FromJson(await File.ReadAllTextAsync(modelPath));
        _client.AuthorizationModelId = (await _client.WriteAuthorizationModel(model)).AuthorizationModelId;

        foreach (var message in messages)
        {
            try
            {
                await _client.Write(new ClientWriteRequest { Writes = Tuples(message) }, IgnoreConflicts);
            }
            catch (FgaApiValidationError error)
            {
                // Een naam die OpenFGA niet aanvaardt: het bericht krijgt geen relaties en blijft dus onzichtbaar.
                _logger.LogWarning("Bericht {Id} overgeslagen bij het aanvullen van OpenFGA: {Error}", message.Id, error.Message);
            }
        }
    }

    public Task<bool> CanAsync(string user, string relation, int messageId) => Ask(async () =>
        (await _client.Check(new ClientCheckRequest
        {
            User = "user:" + user,
            Relation = relation,
            Object = "message:" + messageId
        })).Allowed == true);

    public Task AddAsync(Message message) => Ask(() =>
        _client.Write(new ClientWriteRequest { Writes = Tuples(message) }));

    public Task RemoveAsync(Message message) => Ask(() =>
        _client.Write(new ClientWriteRequest
        {
            Deletes = Tuples(message)
                .Select(t => new ClientTupleKeyWithoutCondition { User = t.User, Relation = t.Relation, Object = t.Object })
                .ToList()
        }, IgnoreConflicts));

    private static List<ClientTupleKey> Tuples(Message message) => new()
    {
        new() { User = "user:" + message.Sender, Relation = "sender", Object = "message:" + message.Id },
        new() { User = "user:" + message.Recipient, Relation = "recipient", Object = "message:" + message.Id }
    };

    // Fail closed: onbereikbaar, geweigerd of een fout antwoord wordt nooit "toegestaan".
    private static async Task<T> Ask<T>(Func<Task<T>> question)
    {
        try
        {
            return await question();
        }
        catch (Exception error)
        {
            throw new FgaUnavailableException(error);
        }
    }
}
