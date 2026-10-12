<div align="center">

[English](README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · **ქართული**

# REA: Reverse Engineer Anything

### ერთი MCP უკუინჟინერიისთვის — ბინარული ფაილებიდან აპლიკაციებამდე და runtime ქცევამდე.

**ნახე ფუნქცია, რომელიც მოგეწონა. გაიგე, როგორ მუშაობს — ბინარულ დონემდე.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#რისი-ანალიზი-შეგიძლია)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[ვებსაიტი](https://rea.tools/ka/) · [გიდები](https://rea.tools/ka/guides/) · [შოუქეისები](https://rea.tools/ka/showcase/)**

[სწრაფი დაწყება](#სწრაფი-დაწყება) · [როგორ მუშაობს REA](#როგორ-მუშაობს-rea) · [რისი ანალიზი შეგიძლია](#რისი-ანალიზი-შეგიძლია) · [შოუქეისები](#შოუქეისები) · [ხშირი კითხვები](#ხშირი-კითხვები) · [დოკუმენტაცია](#დოკუმენტაცია)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA იწყებს ანალიზის ხიდს Hopper-ში ნატიურ ბინარულ ფაილზე მუშაობისას" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>შემოუერთდი უკუინჟინერიის საზოგადოებას</strong>
  </a><br />
  <sub>Discord · კითხვა-პასუხი · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

აპში ნახე ფუნქცია, რომელიც შენს პროდუქტშიც გინდა? სთხოვე აგენტს, გამოიკვლიოს ის REA-თი. მას შეუძლია აპი წყაროს კოდის გარეშე შეამოწმოს, ახსნას როგორ მუშაობს ფუნქცია, აჩვენოს მტკიცებულებები და შენი პროექტისთვის მსგავსი ვერსია ააგოს.

REA აკავშირებს შენს აგენტს ხელსაწყოებთან ნატიური ბინარული ფაილების, JavaScript და Electron აპების, .NET ასემბლებისა და ვებსაიტების შესამოწმებლად. იგივე ხელსაწყოები ტერმინალშიც შეგიძლია გამოიყენო. ანალიზი ლოკალურად სრულდება, ხოლო შედეგებში თითოეული დასკვნის უკან მტკიცებულებები და შეზღუდვებია მოცემული.

Setup REA-ს შენს აგენტზე აძლევს რეგისტრაციას და შესაბამის workflow ინსტრუქციებს აყენებს. ნატიური ანალიზი არსებულ Hopper, Ghidra ან IDA ინსტალაციას იყენებს; setup-ს შეუძლია Hopper-ის დაყენება შენი თანხმობის შემდეგ. სტატიკური JavaScript ანალიზს ნატიური ანალიზის ძრავა არ სჭირდება.

> **[ეწვიე REA-ს ვებსაიტს](https://rea.tools/ka/)** — იქ არის setup ინსტრუქციები, ილუსტრირებული გიდები და რეალური კეისები.

## სწრაფი დაწყება

### დააყენე აგენტი

Node.js-ისა და npm-ის დაყენების შემდეგ გაუშვი:

```bash
npx rea-agents setup
```

აირჩიე აგენტები, გადახედე შემოთავაზებულ ცვლილებებს და დაამტკიცე. Setup ამატებს REA-ს MCP სერვერს და შესაბამის workflow ინსტრუქციებს, არსებული კონფიგურაციის მარაგის ასლებით. შემდეგ თავიდან გაუშვი აგენტი.

Setup მხარს უჭერს Claude Code-ს, Codex-ს, Cursor-ს, Gemini CLI-ს, Grok Build-ს და
[სხვა აგენტებს](docs/installation.md#supported-agents). იხილე
[ინსტალაცია და setup](docs/installation.md) პროვაიდერის კონფიგურაციისა და
ხელით MCP რეგისტრაციისთვის.

### ჰკითხე აგენტს

```text
გაიგე, როგორ მუშაობს ძებნა Notes აპში, მაჩვენე მტკიცებულებები და ააგე
მსგავსი ფუნქცია ჩემი პროექტისთვის.
```

Notes შეცვალე შენი სამიზნე აპით და იმ ფუნქციით, რომლის გაგებაც გინდა.

### გამოიყენე ტერმინალი

შეამოწმე ამოღებული JavaScript/Electron აპის დირექტორია ან ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

შედეგშია მოდულები, იმპორტები, Electron-ის საზღვრები და მათი მტკიცებულებები.
გზა შეცვალე შენი სამიზნით, მაგალითად `"D:/apps/example"` Windows-ზე.

რეგულარული გამოყენებისთვის `rea` ბრძანების დასაყენებლად:

```bash
npm install --global rea-agents
rea --help
```

ნატიური ანალიზისთვის ჯერ პროვაიდერი დააკონფიგურირე. იხილე
[CLI და Evidence გიდი](docs/cli.md) ნატიური ბრძანებების, პროვაიდერის არჩევის,
სნეპშოტებისა და სკრიპტებისთვის.

### განაახლე REA

REA სწრაფად იცვლება და ახალ რელიზებში ხშირადაა შეცდომების გამოსწორება. ინსტალაცია განახლებული შეინარჩუნე.

CLI-სთვის, რომელიც `npm install --global`-ით ან `bun add --global`-ით დააყენე:

```bash
rea update
```

Bun-ის გლობალური განახლება მოითხოვს Bun 1.2.17 ან უფრო ახალს. უფრო ძველი Bun-ის შემთხვევაში ჯერ Bun განაახლე, შემდეგ გაუშვი `rea update`.

აგენტის რეგისტრაციებისა და skill-ის განახლებისთვის გაუშვი ის setup ბრძანება, რომელსაც update დაბეჭდავს.

თუ `npx`-ს იყენებ, აგენტის setup განაახლე ასე:

```bash
npx rea-agents@latest setup
```

გადახედე setup-ის ცვლილებებს და თავიდან გაუშვი აგენტი. ერთჯერადი CLI ბრძანებებისთვის
გამოიყენე `npx rea-agents@latest` და შემდეგ ბრძანება. Bun-ით — `bunx rea-agents@latest`
`npx rea-agents@latest`-ის ნაცვლად.

## როგორ მუშაობს REA

შენი აგენტი REA-ს MCP-ით იძახებს, რათა სამიზნე შეამოწმოს და შესაბამისი კოდი მიადევნოს.
REA აბრუნებს აღმოჩენებს მტკიცებულებებით. აგენტი მათ იყენებს დამატებითი კითხვებისთვის,
ქცევის ასახსნელად ან იმპლემენტაციის დასაწერად და შესამოწმებლად.
CLI ბრძანებები იგივე workflow-ებს იყენებს.

![REA-ს გამოკვლევის ნაკადი: შენი აგენტი ეკითხება ლოკალურ სამიზნეზე, REA ამოწმებს და მიადევნებს მას ანალიზის ხელსაწყოებით, ხოლო აგენტი დაბრუნებულ კოდს, მითითებებსა და უცნობებს იყენებს ასახსნელად, განსახორციელებლად და შესამოწმებლად.](website/public/assets/figures/rea-investigation-flow.svg)

[სრული ზომის ფიგურის გახსნა](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## რისი ანალიზი შეგიძლია

REA საჭიროებს Node.js 22.x (>=22.19), 24.x (>=24.11) ან 26+-ს და npm-ს.
დამატებითი ხელსაწყოები და ჰოსტის მხარდაჭერა სამიზნეზეა დამოკიდებული:

| სამიზნე                     | რას აბრუნებს REA                                                                                    | მოთხოვნები და გიდი                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ნატიური ბინარული ფაილები    | ფსევდოკოდი, ასემბლერი, სტრინგები, სიმბოლოები, გამოძახებები და მითითებები                            | Hopper, Ghidra ან IDA; [ნატიური ანალიზი](https://rea.tools/ka/guides/native/)                                                      |
| Offline ELF layout          | სექციები, სეგმენტები, ორიგინალი სიმბოლოები/რელოკაციები და სტატიკური mitigation კანდიდატები          | გამომძახებლის მიერ მოწოდებული pwntools Linux x64-ზე; [ბინარული დიაგნოსტიკა](docs/binary-diagnostics.md)                            |
| Go ბინარული ფაილები         | ჩაშენებული კომპილატორის ვერსია, მოდულები, ჩანაცვლებები და build პარამეტრები                         | ჩაშენებული სტატიკური ELF/PE/thin Mach-O შემოწმება; Go ინსტალაცია არ არის საჭირო                                                    |
| WASM artifact               | ვალიდაცია, სექციები, ზუსტი import/export WAT ფორმები და დეკოდირებული WAT                            | გამომძახებლის მიერ მოწოდებული WABT 1.0.42; `inspect_wasm_artifact`                                                                 |
| EVM bytecode                | Dispatch სელექტორები, ბაიტების ოფსეტები, გამოთვლილი არგუმენტები და mutability                       | ლოკალური raw/hex carrier Linux x64-ზე; [offline EVM გიდი](docs/evm-bytecode.md)                                                    |
| ჩაწერილი Linux crash-ები    | ნედლი შენიშვნები, ყველა ჩაწერილი thread-ის რეგისტრები/სიგნალები და ოფციონალური mapping კანდიდატები  | გამომძახებლის მიერ მოწოდებული pwntools Linux x64-ზე; ოფციონალურად GDB/pwndbg; [ჩაწერილი crash-ები](docs/recorded-crashes.md)       |
| JavaScript / Electron       | მოდულები, იმპორტები, source map-ები, მარშრუტები, IPC და ნატიურ add-on-ებთან კავშირები               | Node.js და npm; [აპლიკაციის ანალიზი](https://rea.tools/ka/guides/javascript/)                                                      |
| ვებსაიტები                  | გვერდის სტრუქტურა, სკრიპტები, ქსელური დაკვირვებები და მოთხოვნილი სკრინშოტები                        | Chrome-ოჯახის ბრაუზერი; [ბრაუზერის ანალიზი](https://rea.tools/ka/guides/browser/)                                                  |
| შენახული ქსელური ჩანაწერები | მოთხოვნები, პასუხები, ხელმისაწვდომი payload-ები და წყაროს მდებარეობები                              | HAR; mitmdump Linux-ზე ნატიური mitmproxy ჩანაწერებისთვის; [ქსელური ჩანაწერების გიდი](docs/web-network-captures.md)                 |
| .NET ასემბლები              | მეტამონაცემები, CIL ინსტრუქციები, დეკლარირებული ნატიური დამოკიდებულებები და build შედარებები        | არაფერი (მხოლოდ სტატიკური); [managed-code გიდი](docs/managed-code-analysis.md)                                                     |
| Android APK-ები             | Manifest დეკლარაციები, კლასები, დეკომპილირებული მეთოდები და მითითებები                              | Headless JADX და სრული JDK Linux/macOS/Windows x64-ზე; [Android გიდი](docs/android-analysis.md)                                    |
| Android მოწყობილობები       | მოწყობილობები, პაკეტები, პროცესები, ლოგები, dump-ები, ეკრანის გადაღებები და APK/ფაილის გადატანა     | გამომძახებლის მიერ მოწოდებული adb (ემულატორი ან აპარატი); [ADB გიდი](docs/adb-device-analysis.md)                                  |
| JEB პროექტები               | ძრავაზე დაფუძნებული პროექტის ერთეულები, artifact digest-ები და ტიპის/მეთოდის ფსევდოკოდი             | გამომძახებლის მიერ გაშვებული JEB კლიენტი MCP-ით, არჩეული REA_JEB_MCP_URL-ით; [JEB გიდი](docs/jeb-analysis.md)                      |
| Android რესურსები           | დეკოდირებული manifest, სტრინგების ცხრილები, ლოკალები და ვერსიის ფაქტები                             | გამომძახებლის მიერ მოწოდებული Apktool launcher; [რესურსების გიდი](docs/apktool-resource-analysis.md)                               |
| Flutter აპები               | Dart snapshot hash, per-ABI ბიბლიოთეკის digest-ები და ძრავის build provenance                       | არაფერი (სტატიკური APK პარსინგი); [Flutter გიდი](docs/flutter-analysis.md)                                                         |
| Firmware                    | რეგიონები, ამოღების შედეგები და ნატიურ ანალიზზე გადაცემა                                            | Binwalk / Unblob Linux-ზე; [firmware გიდი](docs/firmware-analysis.md)                                                              |
| პაკეტები და რესურსები       | ფაილების ინვენტარი, digest-ები, plist-ები, Apple bundle ანატომია და ამოღებული რესურსები             | [Artifact და JavaScript გიდი](docs/javascript-artifact-reconstruction.md), [Apple აპლიკაციები](docs/apple-application-analysis.md) |
| პროცესის ქცევა              | ტერმინალის გამოსავალი, ინტერაქციები, გასვლისა და ფაილური სისტემის დაკვირვებები, გაშვების შედარებები | Linux/macOS ნატიური PTY-ით; [პროცესის ჩაწერა](docs/process-capture.md)                                                             |

სტატიკური JavaScript და .NET შემოწმება კითხულობს მოწოდებულ ფაილებს აპლიკაციის გაშვების გარეშე. Runtime ჩაწერა არჩეულ სამიზნეს შენი მომხმარებლის უფლებებით უშვებს ან ურთიერთობს მასთან; თითოეული runtime გიდი აღწერს მის ეფექტებს.

<a id="choosing-a-deep-analysis-provider"></a>

ნატიური ფორმატები და ჰოსტის მხარდაჭერა პროვაიდერის მიხედვით განსხვავდება. იხილე
[Hopper და Ghidra setup](docs/installation.md#hopper),
[IDA გიდი](docs/ida-provider.md) და
[ექსპერიმენტული Windows Ghidra მხარდაჭერა](docs/windows-ghidra-p0.md).
Ghidra ასევე მხარს უჭერს [16-ბიტიან DOS ანალიზს](docs/ghidra-dos.md).
დიდი ბინარული ფაილებისთვის გაზარდე პროვაიდერის startup ვადა
`REA_GHIDRA_STARTUP_TIMEOUT_MS` ან `REA_HOPPER_STARTUP_TIMEOUT_MS`-ით.
პროვაიდერის არჩევისთვის იხილე [CLI გიდი](docs/cli.md#choose-a-provider).
შეამოწმე [რელიზის ხელმისაწვდომობა](docs/installation.md#released-package-and-main)
იმ ფუნქციებისთვის, რომლებიც ბოლო npm რელიზის შემდეგ დაემატა.

## შოუქეისები

[![DX-Ball sound-pan, Notion clipboard-bridge და TH04 bullet-ring შოუქეისების ილუსტრაციები](docs/assets/rea-showcases.png)](https://rea.tools/ka/showcase/)

### DX-Ball: sound-pan გამოთვლის რეკონსტრუქცია

მიჰყევი ხმის გამოძახებას პოზიცია–pan დამხმარე ფუნქციამდე, შეამოწმე ინსტრუქციები
და არასრული ფსევდოკოდი C-ში გადაიყვანე. რეკონსტრუქცია გადის 3,205
ორიგინალ x86 კეისს და ამრავლებს კომპილირებული ფუნქციის ყველა 63 ბაიტს.

[კეისის წაკითხვა](https://rea.tools/ka/showcase/dx-ball/) ·
[რეკონსტრუქციის რეპოზიტორი](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron clipboard ხიდის კვალდაკვალ გაყოლა

იპოვე renderer-ის clipboard API, გაიარე preload და IPC მთავარ პროცესამდე
და შეამოწმე მდიდარი clipboard ფორმატი.

[კეისის წაკითხვა](https://rea.tools/ka/showcase/notion/)

### TH04: DOS bullet-ring გამოთვლის აღდგენა

შეამოწმე ორიგინალი PC-98 თამაშის 16-ბიტიანი ინსტრუქციები, აღადგინე ფიქსირებული და
მიმართული კუთხის გამოთვლები და შეადარე რეკონსტრუირებული C++ ისტორიული
კომპილატორის გამოსავალს.

[კეისის წაკითხვა](https://rea.tools/ka/showcase/th04/) ·
[რეკონსტრუქციის რეპოზიტორი](https://github.com/N0zoM1z0/th04)

თუ REA-თი რაიმე საინტერესო გამოიკვლიე, სიამოვნებით ვნახავთ. გააზიარე შენი
კეისი [issue](https://github.com/morluto/rea/issues)-ში ან
[pull request](https://github.com/morluto/rea/pulls)-ში — ჩართე სამიზნე,
შენი კითხვა, როგორ დაგეხმარა REA და რა აღმოაჩინე.

## ხშირი კითხვები

<details>
<summary><strong>რომელ აგენტებს შეუძლიათ REA-ს გამოყენება?</strong></summary>

ნებისმიერ აგენტს, რომელიც ლოკალურ MCP სერვერებს მხარს უჭერს. Setup აკონფიგურირებს
[მხარდაჭერილ აგენტებს](docs/installation.md#supported-agents); სხვა კლიენტებს შეუძლიათ
[ხელით MCP რეგისტრაცია](docs/installation.md#mcp-registry).

</details>

<details>
<summary><strong>მჭირდება Hopper, Ghidra ან IDA?</strong></summary>

ღრმა ნატიური ანალიზი ერთ-ერთს იყენებს. სტატიკური JavaScript და .NET შემოწმება
ნატიური ანალიზის ძრავის გარეშე მუშაობს. Setup-ს შეუძლია Hopper-ის დაყენება თანხმობის შემდეგ;
Ghidra და IDA შენს არსებულ ინსტალაციებს იყენებენ. იხილე [პროვაიდერის setup](docs/installation.md#hopper).

</details>

<details>
<summary><strong>საჭიროა Hopper-ის წინასწარ გაშვება?</strong></summary>

REA Hopper-ს მაშინ იწყებს, როცა ოპერაციას სჭირდება. macOS-ზე პირველ გაშვებაზე დიალოგი
შეიძლება გთხოვოს დემო რეჟიმის არჩევა ან ლიცენზიის აქტივაცია. ეს მოთხოვნა დაასრულე იმავე
სესიაში პირველ CLI/MCP ოპერაციამდე ან unattended სამუშაომდე. საჭიროების შემთხვევაში Hopper
ხელით გახსენი. იხილე
[Hopper-ის გაშვება და პრობლემების მოგვარება](docs/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>რას აკეთებს skill-ის დაყენება skills.sh-დან?</strong></summary>

Skill აგენტს გამოკვლევის ინსტრუქციებს აძლევს. გამოიყენე `npx rea-agents setup`
REA-ს MCP სერვერის დასარეგისტრირებლად და შესაბამისი ინსტრუქციების დასაყენებლად, შემდეგ თავიდან
გაუშვი აგენტი. იხილე [მხოლოდ skill-ის ინსტალაცია](docs/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>რა კოდს აბრუნებს REA?</strong></summary>

ნატიური ანალიზი აბრუნებს ფსევდოკოდს და ასემბლერს. JavaScript/Electron ანალიზი
აღადგენს მოდულებს და მათ კავშირებს. შენი აგენტი ამ აღმოჩენებს იყენებს იმპლემენტაციის
დასაწერად და შესამოწმებლად; [შოუქეისები](#შოუქეისები) კონკრეტულ მაგალითებს იძლევა.

</details>

<details>
<summary><strong>ატვირთავს თუ არა REA ჩემს აპს?</strong></summary>

REA სამიზნეებს ლოკალურად აანალიზებს. აგენტი იღებს ხელსაწყოების შედეგებს, ხოლო მისი
მოდელის პროვაიდერს საკუთარი მონაცემთა პოლიტიკა აქვს.

</details>

<details>
<summary><strong>რა უნდა ვქნა, თუ შეცდომას წავაწყდი?</strong></summary>

ჯერ განაახლე; ბოლო რელიზმა შესაძლოა უკვე გაასწოროს.

CLI-სთვის, რომელიც `npm install --global`-ით ან `bun add --global`-ით დააყენე:

```bash
rea update
```

აგენტის setup-ისთვის `npx`-ით:

```bash
npx rea-agents@latest setup
```

თუ აგენტს იყენებ, დაასრულე [setup-ის განახლება](#განაახლე-rea) და თავიდან გაუშვი.
იგივე დავალება ხელახლა სცადე. თუ პრობლემა გრძელდება, [გახსენი issue](https://github.com/morluto/rea/issues)
REA-ს ვერსიით, სამიზნის ტიპით, გამეორების ნაბიჯებით და შეცდომის გამოსავლით.

</details>

## დოკუმენტაცია

დაიწყე ვებსაიტის [პრაქტიკული გიდებით](https://rea.tools/ka/guides/).
ზუსტი ოფციების, წინაპირობებისა და შედეგის კონტრაქტებისთვის:

- [ინსტალაცია და setup](docs/installation.md): აგენტის რეგისტრაცია, პროვაიდერის კონფიგურაცია, განახლებები და uninstall.
- [მზადყოფნა და პრობლემების მოგვარება](docs/installation.md#check-readiness-for-your-task): ერთი აგენტის ან ანალიზის ძრავის დიაგნოსტიკა.
- [CLI და Evidence](docs/cli.md): ბრძანებები, პროვაიდერის არჩევა, სნეპშოტები, import/export და გასვლის სტატუსები.
- [MCP კონტრაქტები](docs/mcp-contracts.md) და [აგენტის პრომპტები](docs/mcp-prompts.md): ხელსაწყოების შედეგები, სესიები და მიმართული გამოკვლევები.
- [ხელსაწყოების კატალოგი](docs/mcp-contracts.md#generated-catalog): ხელსაწყოების, პროვაიდერებისა და CLI ბრძანებების გენერირებული ინვენტარი.
- [გზამკვლევი (roadmap)](docs/roadmap.md): დაგეგმილი სამუშაო და შესაძლებლობების ტრეკერები.

დაუცველობები შეატყობინე [SECURITY.md](SECURITY.md)-ით.

## ვარსკვლავების ისტორია

🎉 **110,000 GitHub ვარსკვლავი — გმადლობთ!**

მადლობა ყველას, ვინც REA-ს იყენებს, შეცდომებს აცნობებს, ფუნქციებს ითხოვს, ბილდებს ამოწმებს და გასწორებებს უწყობს ხელს.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Disclaimer

იხილე [DISCLAIMER.md](DISCLAIMER.md) პასუხისმგებლიანი გამოყენების სახელმძღვანელოსთვის.

პროექტის პოზიცია უკანონო ან არაავტორიზებულ გამოყენებაზე ვრცელდება REA-ს ყველა ვერსიაზე,
გავრცელების არხსა და პლატფორმაზე; თითოეული ასლი ინარჩუნებს შესაბამის ლიცენზიებს.

REA განკუთვნილია კანონიერი კვლევის, განათლების, თავსებადობის, პროგრამული უზრუნველყოფის შენარჩუნების
და იმ პროგრამების ანალიზისთვის, რომლებიც გეკუთვნის ან რომელთა შემოწმების უფლებაც გაქვს.

## წვლილის შეტანა

სიამოვნებით მივიღებთ შენს დახმარებას REA-ში! [გახსენი issue](https://github.com/morluto/rea/issues)
შეცდომის ან ფუნქციის შემოთავაზებისთვის, ან [გააგზავნე pull request](https://github.com/morluto/rea/pulls)
კოდის ან დოკუმენტაციის გასაუმჯობესებლად.

იხილე [CONTRIBUTING.md](CONTRIBUTING.md) დეველოპმენტის setup-ისა და შემოწმებებისთვის,
[ტესტირება](docs/testing.md) ვერიფიკაციის ლეინებისთვის და
[არქიტექტურის რუკა](docs/architecture.mermaid) პროექტის სტრუქტურისთვის.

## ლიცენზია

[MIT](LICENSE)

REA-ს ავტორული კოდი MIT ლიცენზიითაა. მესამე მხარის მასალა ინარჩუნებს საკუთარ
ლიცენზიებსა და საავტორო უფლებების შენიშვნებს; იხილე
[მესამე მხარის შენიშვნები](THIRD_PARTY_NOTICES.md) დამოკიდებულებების ინვენტარისთვის,
შენახული ლიცენზიის ტექსტებისა და გარე ხელსაწყოების პირობებისთვის.

**კომერციული ხელსაწყოები კანონიერად უნდა მოიპოვო და გამოიყენო ავტორიზებულად**, მათ შორის
IDA Pro / Hex-Rays დეკომპილატორები, Hopper და JEB, მათი შესაბამისი
ლიცენზიებით. REA არ გაძლევს ხელსაწყოს ლიცენზიას, გასაღებს ან აქტივაციის უფლებას. საცდელი ვერსიები და
დემოები კვლავ ექვემდებარება გამყიდველის პირობებს, მათ შორის მომხმარებლის, ფუნქციის, ავტომატიზაციისა და
გამოსავლის გაზიარების შეზღუდვებს. გატეხილი ასლები, მოპარული გასაღებები, არაავტორიზებული გასაღების
გაზიარება და ლიცენზიის შეზღუდვების გვერდის ავლა ავტორიზებული არ არის. ეს სახელმძღვანელო
არ ცვლის MIT ან მესამე მხარის ლიცენზიებს.
