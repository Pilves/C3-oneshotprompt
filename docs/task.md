## Tubli! Oled tõestanud oma väärtust.

### Ülesanne

Kasutajalugu:

Analüütikud koguvad uurimiste käigus erinevaid leide: domeen, IP-aadress, e-posti aadress, kasutajanimi, pseudonüüm või krüptorahakott. Igal leiul on allikas, ajatempel, märkmed ja juhtum, mille juurde see kuulub. Sinu ülesanne on väike veebirakendus, millega analüütik saab leide otsida ja sirvida. Lisaks sellele MCP liides.

#### Andmestik

findings.json: umbes 1000 artefakti, mis on kogutud mitmest allikast ja tööriistast. Andmed ei ole korrastatud kujul.

[findings.json (1032 kirjet)](https://cyber.politsei.ee/kuulutused/findings.json)

#### Mida teha?

##### 1. Backend (Node.js; mis tahes raamistikuga või ilma)

- Laadi json ja tee need vabatekstiga otsitavaks nii olemi (entity) kui ka märkmete järgi. Kuidas sa andmeid hoiad ja otsid, on sinu otsustada. Põhjenda oma valikut.
- HTTP API, mida kasutajaliides kasutab artefaktide otsimiseks. Soovi korral võid juurde lisada erinevaid filtreid, ja küsida ühte atrefakti selle id järgi.
- Analüütikud otsivad eesti ja inglise keeles.

##### 2. MCP liides

MCP tööriistad:

- search_findings (vabatekstiline päring, valikulised filtrid)
- get_finding (id järgi)
- list_cases

Kasuta Streamable HTTP ja serveeri /mcp otspunktil, järgides MCP spetsifikatsiooni versiooni 2026-07-28.

[modelcontextprotocol.io/specification/2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)

##### 3. Kasutajaliides

- Otsingukast ja tulemuste loend, kus otsingule vastav tekst on esile tõstetud, ning filter tüübi järgi.
- Ühe artefakti detailvaade koos lingiga selle allikale.
- Liides ei pea olema ilus. See peab olema kasutatav ja korrektne.

##### 4. Rakenduse jooksutamine

Kogu rakendus peab jooksma docker composega:

docker compose up --build

#### Mida meile saata

Saada link avalikule Git-repositooriumile (saame antud juhul pilgu peale heita sinu teistele tegemistele) ja lisa emaili oma avamiskood.

Palun ära kasuta (squash)i. Tahame näha, kuidas töö kulges.

Repositooriumis peab olema README.md, mis sisaldab endas:

- kuidas projekt üles seada ja käivitada
- selgitab sinu arhitektuuriotsuseid
- toob välja eeldused ja kompromissid, kuidas jsonis olevate andmetega käitlesid

#### Reeglid

- AI-tööriistad on lubatud.
- Ülesandes ja andmetes on teadlikult jäetud ebaselgusi ja puudujääke. Nende märkamine ja dokumenteerimine on ülesande osa.