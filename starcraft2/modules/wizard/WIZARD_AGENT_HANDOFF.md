# Handoff: дальнейшая разработка `sc2-wizard`

Документ предназначен для следующего агента, который продолжит работу над
модулем StarCraft II Wizard в репозитории
`C:/FILES/SC2Files/coding/modkit-extensions-blizzard`.

## Цель задачи

Довести модуль `blizzard/sc2-wizard` до полноценного MK3-модуля Modkit:

```text
.BlizWiz / EditorWizards
  -> lossless parser + typed model
  -> schema-aware diagnostics/evaluation
  -> codec + generic MCP data surfaces
  -> MK3 language provider/LSP
  -> bounded workspace/dependency index
  -> safe writer/edit operations
```

Главные требования:

- не терять неизвестные XML-узлы, атрибуты, комментарии, порядок, пробелы,
  кавычки и исходные диапазоны;
- отделять доказанную спецификацию от corpus/runtime-гипотез;
- не превращать отсутствие dependency/schema в ложную ошибку;
- не объявлять structural editing или save, пока не пройдены реальные
  parse/write/reopen round trips;
- сохранять совместимость с MK3 contribution/provider contracts.

## Что уже сделано

### Codec и parser

Точки входа:

- [codec.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/codec.ts)
- [parse.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/parse.ts)
- [types.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/types.ts)
- [analyze.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/analyze.ts)
- [evaluate.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/evaluate.ts)
- [outline.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/outline.ts)
- [write.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/codecs/wizard/src/core/write.ts)

Реализовано:

- lossless XML AST `WizardNode`;
- typed model для `wizardfile`, `wizard`, `input`, `item`, `condition`,
  `validate`, `macro`, `entry`, `field`, `token` и metadata;
- строгий `wizardfile` root по умолчанию;
- явные parser options (evidence: `runtime-confirmed` — SC2Editor принимает
  такие корни, хотя спецификация говорит «should be wizardfile»; в корпусе их
  нет):
  - `caseInsensitiveRoot`;
  - `allowStandaloneWizard`;
- `WizardFile.rootKind`: `wizardfile` или compatibility
  `standalone-wizard`;
- strict/editor-compatible analysis mode;
- compatibility diagnostics для case-variant root, standalone root
  (`runtime-confirmed`) и legacy `validate` без `type` (`corpus`);
- evaluation tokens, macro expansion, arithmetic и catalog references;
- schema adapter через полный SC2 data schema — используется только language
  provider; codec `inspect` явно сообщает `catalogChecks: 'not-run'`;
- read-only codec operations для validate/inspect/raw export/outline/evaluate;
- `edit.field` — edit plan на одно существующее значение (host commit +
  reopen доказан, см. раздел 6).

### MK3 language provider

Точки входа:

- [provider.json](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/providers/language/provider.json)
- [runtime.js](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/providers/language/runtime.js)
- [language.ts](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/providers/language/src/language.ts)

Provider публикует:

- contract `common.language/document-analysis@1`;
- language ID `sc2-wizard`;
- document kind `sc2-wizard-source`;
- extension `blizwiz`;
- trusted-node и portable runtime variants.

Реализованы provider operations:

- `analyze`;
- diagnostics;
- tokens;
- hierarchical document symbols;
- completion для XML tags/attributes, enum values, input/macro/wizard IDs,
  SC2 catalog/type и schema field paths;
- hover;
- definition;
- references;
- guarded rename;
- final-newline formatting;
- source code actions;
- workspace symbols.

Provider использует parser/analyzer/evaluator/schema и словарь грамматики
(`KNOWN_ATTRIBUTES`, `KNOWN_CHILDREN`, enum-наборы) из codec-модуля.

Поддерживается bounded workspace snapshot для локальных и cross-file ссылок
`Wizard:<id>` / `wizardid:subtoken`. Rename отказывается работать при
`workspaceIncomplete === true`.

### Registry и package wiring

Проверь связанные файлы:

- [starcraft2/package.json](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/package.json)
- [architecture/module-map.json](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/architecture/module-map.json)
- [architecture/module-map.inventory.json](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/architecture/module-map.inventory.json)
- [tsconfig.sc2-wizard.json](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/tsconfig.sc2-wizard.json)

Contribution ID language provider:

```text
blizzard/sc2-wizard-language
```

Target в module map:

```text
packages/starcraft2/modules/wizard/providers/language
```

## Проверенное состояние

Последний проверенный набор wizard-тестов (перепроверено 2026-09-15):

```text
pnpm --dir ./starcraft2 exec vitest run modules/wizard/test/language.test.ts \
  modules/wizard/test/format.test.ts \
  modules/wizard/test/native.test.ts
```

Результат: `85 passed`; с `MODKIT_TEST_INSTALLED_CORPUS=1` плюс
`wizard-corpus.test.ts` — `94 passed` (включая native host edit test и edit-isolation gate).

TypeScript:

```text
pnpm exec tsc --pretty false --noEmit -p ./starcraft2/tsconfig.sc2-wizard.json
pnpm exec tsc --pretty false -p ./starcraft2/tsconfig.sc2-wizard.json
```

Оба запуска проходят.

MK3 registry checks:

```text
pnpm run contributions:check
pnpm run test:module-map
```

Оба проходят после регистрации `sc2-wizard-language` и генерации inventory.

Standalone provider runtime smoke:

```text
node --input-type=module -e '... import("./starcraft2/modules/wizard/providers/language/runtime.js") ...'
```

Проверено: `abiVersion: 1`, contract
`common.language/document-analysis`, language ID `sc2-wizard`, diagnostics
на валидном документе без ошибок.

Общий smoke suite ранее проходил `7/7`; после изменений других агентов не
следует считать весь worktree чистым — сначала повторить его перед интеграцией.

Первый срез закоммичен в `main` как `b4282673` (provider, rename fixes,
корпус, ложные ошибки). Последующие правки (неоднозначный owner в rename,
workspace-диагностика) — смотри `git log` / `git status`.

## Аудит 2026-09-15: что оказалось неверным

### Реальный корпус существует

Утверждение «корпуса нет» (в `test/fixtures/manifest.json`, комментариях
`codec.ts`, `parse.ts`, limitations в `define.ts`) устарело. Локально найдено
9 настоящих `.BlizWiz`:

```text
C:/FILES/SC2Files/AllRaces/all-races-scevo-merger/scevo-core.SC2Mod/
  Launch Missile.BlizWiz
  test.BlizWiz
  Base.SC2Data/Wizards/SCBW/CreateSCBWUnit.BlizWiz
  Base.SC2Data/Wizards/SCBW/SCBW Ability.BlizWiz
  Base.SC2Data/Wizards/SCBW/SCBW Effects.BlizWiz
  Base.SC2Data/Wizards/SCBW/SCBW Requirements.BlizWiz
  Base.SC2Data/Wizards/SCBW/SCBW Upgrades.BlizWiz
  Base.SC2Data/Wizards/SCBW/SetSCBWImportedData.BlizWiz
C:/FILES/SC2Files/AllRaces/factions-backup/UPL2023.SC2Mod/LaunchMissile.BlizWiz
```

Искались только распакованные директории; упакованные `.SC2Mod/.SC2Map`
читать через mpq codec, не ad-hoc скриптами. Лицензия не выяснена.

Факты по корпусу (ad-hoc прогон на `dist`):

- parse → write byte-identical на 9/9; все файлы CRLF, без BOM;
- все корни — канонический `<wizardfile>`; case-variant и standalone корней
  **нет** — эти compatibility options остаются гипотезой;
- встречаются: `validate` без `type`, `entry` с `<useloaded/>` без `type`,
  `^EffectCreation:Identification^` (owner-wizard в другом файле), id с
  пробелом (`Art Fields`), 60 XML entities.

Ложные hard errors analyzer на корпусе (со schema):

- 89× `unknown-field` — все на `field id="Name"`;
- 12× `unknown-token` — qualified-токены на wizard из другого файла;
- `missing-attribute` для `entry/@type` рядом с `useloaded` (сверить с
  `fileformat.rtf`).

Настоящая находка: опечатка `create="RequierementNode"` в
`SCBW Upgrades.BlizWiz`.

### Rename портил файлы

Отмеченный как готовый guarded rename давал битый результат:

1. entity перед токеном сдвигал offsets: `a &amp; ^Value^` → `a &amAmountalue^`;
2. rename `Wizard:`-input не менял owner-сегмент в `^Child:Nested^`;
3. rename wizard `C` не менял `^C:Nested^`, но возвращал `isComplete: true`.

Исправлено 2026-09-15 в `providers/language/src/language.ts` (общий
`addInputName` для токенов, `condition/@input`, `loadinput`, `reloadfrom`;
сканирование сырого source; запрет `:` в новом имени), 5 новых тестов, итого
56 passed, typecheck и `dist` build проходят, runtime smoke и
`contributions:check` зелёные. Открыто: неоднозначность, когда wizard id и
`Wizard:`-input называются одинаково.

## Фокус следующего агента

Работать в следующем порядке.

### 1. Корпус и ложные ошибки

Сделано 2026-09-15:

- `test/fixtures/corpus.json` + `test/wizard-corpus.test.ts` (тир `real`,
  `MODKIT_TEST_TIER=real`; корень `MODKITX_SC2_WIZARD_CORPUS_ROOT`): sha256,
  byte round trip, число wizard, baseline диагностик по кодам. Файлы читаются
  на месте, не копируются — лицензия не установлена.
- Ложные ошибки убраны: `Name`/`EditorPrefix`/`EditorSuffix` приняты в schema
  adapter; `embedded-token-unresolved` warning; `legacy-missing-entry-type`
  warning в editor-compatible. После сессии SC2Editor error на корпусе нет:
  `RequierementNode` (настоящая опечатка) и `Ability` (редактор выбрасывает
  его при сохранении) — warning `unknown-object-type`.
- Устаревшее «корпуса нет» убрано из `codec.ts`, `parse.ts`, `define.ts`,
  `manifest.json`; `codec.json` перегенерирован emitter-ом.

Также сделано:

- словарь грамматики provider берётся из экспортов `analyze.ts`;
- codec не грузит schema (намеренно) и теперь явно сообщает
  `catalogChecks: 'not-run'` в `inspect` и соответствующий пункт в
  `unsupportedFeatures` descriptor.

Проверено в SC2Editor 2026-09-15 (`artifacts/editor-acceptance-2026-09-15/wizards/`):
`Abil` распознаётся, `Ability` выбрасывается при сохранении; loaded entry без
`type`/`id` загружается и пишет поле при Finish; `<count>` внутри `<input>`
игнорируется. Экспорт редактора лежит как `test/fixtures/editor-saved-export.BlizWiz`
(оракул сериализации, `-text`). Не проверен только Wizard View.

### 2. Workspace index (Phase 5)

Основной backlog находится в
[WIZARD_IMPLEMENTATION_PLAN.md](C:/FILES/SC2Files/coding/modkit-extensions-blizzard/starcraft2/modules/wizard/WIZARD_IMPLEMENTATION_PLAN.md).

Исходная идея `WizardWorkspaceIndex` с собственными VFS, precedence и
invalidation **отменена**: это уже делает host
(`LanguageWorkspaceOptions.documentSource`,
`createContentDependencyLanguageDocumentSource` в `modkit-core/packages/host`:
dependency closure по loose/MPQ/CASC mounts, порядок загрузки, completeness,
read-only dependency-документы, отказ в edits при incomplete). Provider только
потребляет snapshot и ничего не читает сам.

Сделано 2026-09-15 на стороне provider/analyzer:

- `analyzeWizardDocument({ externalWizards })` — embedded wizards и
  `^Owner:Input^` из других документов snapshot резолвятся;
  `duplicate-wizard-elsewhere` warning с источниками;
- `diagnostics` передаёт snapshot в analyzer; `definition` учитывает
  `workspaceIncomplete`; rename отказывает при нескольких объявлениях символа;
- кеш разбора по тексту (FIFO, 64).

Осталось: композиция SC2 host document source, включающая `.BlizWiz` из
`EditorWizards`, map/mod mounts и dependency layers, и проверка на
смонтированном `.SC2Mod`. Это задача app/host-композиции, не provider.

### 3. Расширить corpus и specification fixtures

Корпус из аудита — стартовая точка. Дополнительно искать `.BlizWiz` внутри
упакованных map/mod архивов (через mpq codec) и получить `editorSaved` файлы
экспортом из SC2Editor (Manage Wizards > Export).

Для каждого fixture записать:

- источник и путь;
- licence/provenance;
- игру/патч, если известно;
- какие элементы и compatibility forms реально встречаются;
- ожидаемые diagnostics.

Не подменять реальные файлы реконструированными примерами. Реконструированные
fixtures оставить как specification fixtures.

Минимальные новые группы тестов:

- все documented elements/attributes;
- malformed XML и truncated input;
- duplicate IDs и missing required values;
- macro cycles и embedded wizard cycles;
- conditions и nested logic;
- catalog references/arrays/arithmetic;
- unknown nodes/attributes с preservation;
- uppercase/standalone/legacy forms отдельно от strict fixtures.

### 4. Усилить semantic analyzer

Сделано 2026-09-15: `evaluation-cycle` (макросы и default input), исправлен
крэш evaluator на `<default value="^A^"/>` (переполнение стека в `evaluate` и
hover), дубликаты именованных `condition`.

Спецификация прочитана через Modkit (`blizzard/casc`, `container.extract`;
`fileformat.rtf` + `general.rtf`, в репозиторий не кладутся). По тексту добавлены
`color-ignored`, `reloadfrom-without-loadvalue`, `invalid-value` для
`page/column/minheight/minwidth/truncate`, `view-hidden`, обязательный
`entry/id` (strict error, legacy warning при `useloaded`). `parentid` и
`token/@id` — ссылки в каталог, проверяются только с catalog data (Phase 4).
Подробности и что осталось — Phase 3 в плане.

Текущая analyzer implementation уже проверяет часть structural/schema rules,
но нужно пройти всю матрицу из WizardHelp:

- `objecttypes create/load/view`;
- input controls, layout, defaults, item values, reload behavior;
- named/inline conditions, `match`, `operator`, `logic`, `nocase`, `empty`,
  `visible`;
- validation type/text semantics;
- entry parent IDs, loaded-entry behavior, arrays/count/index;
- field/token `loadinput` и conditions;
- duplicate/undefined wizard/input/macro/condition/entry/token IDs;
- distinction между unknown schema, incomplete schema и proven invalid schema.

Каждое новое правило должно иметь fixture и focused test.

### 5. Generic MCP verification

После стабилизации workspace context проверить generic MK3 surfaces на реальном
wizard document:

- `modkit.inspect`;
- `modkit.subject_facts`;
- `modkit.relation_graph`;
- `modkit.invoke_readonly`;
- `modkit.language` diagnostics/symbols.

Wizard-specific MCP server не добавлять, пока generic contracts не окажутся
недостаточными.

### 6. Writer/editing только после round-trip gate

Сделано 2026-09-16: `edit.field` (`codecs/wizard/src/core/edit.ts` +
handler `edit-field` в `codec.ts`) возвращает `AssetEditPlan` через
`editPlanFromInput`/`replaceBytes`, как Style codec. Правка заменяет ровно одно
существующее значение (input default, item value/text, macro text, value
именованного condition, value поля entry), ничего не вставляет, учитывает BOM.
Host commit + reopen доказан в `test/wizard-native-host.test.ts` на файле,
сохранённом SC2Editor. Политика: minimal-diff, а не пересериализация как в
редакторе. Открыто: вставка/удаление элементов, reopen отредактированного
Modkit файла в самом SC2Editor (копия и чек-лист готовы:
`artifacts/editor-acceptance-2026-09-15/wizards-edited/`).

Также 2026-09-16: gate изоляции правок (`test/edit-isolation.ts`) на фикстурах и
корпусе; исправлен дефект — info-диагностика отдавалась как `info` вместо
`information`, из-за чего host не открывал такие файлы (например корпусный
`CreateSCBWUnit.BlizWiz`).

Исходный чек-лист (для следующих видов правок):

- BOM и encoding (BOM сейчас срезается `TextDecoder` до парсинга и writer его
  не восстановит);
- CRLF/LF;
- comments и whitespace;
- quote style и attribute order;
- unknown nodes/attributes;
- source ordering;
- self-closing/open-close form;
- parse -> write -> parse semantic equivalence;
- byte identity для untouched document.

Затем начинать с dry-run edit plans и малых изменений:

1. input defaults/items;
2. macros;
3. conditions;
4. field/token values;
5. cross-file edits только при полном индексе и полном snapshot.

Не добавлять edit/save в `define.ts`/codec contribution до прохождения reopen
тестов на реальных corpus files.

### 7. Binary/runtime reverse engineering (низкий приоритет)

Структура содержимого уже установлена `fileformat.rtf` и корпусом. Реверс нужен
только для гипотетических compatibility-корней, и быстрее проверить их через
SC2Editor на тестовом моде, чем через Ghidra (тела функций в экспорте
обрезаны).

Материалы исследования находятся в:

- `C:/FILES/SC2Files/coding/reports/BLIZWIZ_FORMAT_RESEARCH_RU.md`;
- адрес строки `.BlizWiz`: `0x350cfd0`;
- исследовательские заметки по FiletypeTable/xrefs/CASC/MPQ/VFS.

Следующий reverse-engineering шаг:

- найти xrefs к строке `.BlizWiz`;
- восстановить descriptor в `FiletypeTable`;
- найти suffix detection, XML loading, VFS/dependency lookup, reload/save;
- подтвердить или опровергнуть uppercase roots, standalone roots, missing
  validation type и direct input count;
- результаты классифицировать как `documented`, `corpus`,
  `runtime-confirmed` или `hypothesis`.

## Важные ограничения и ловушки

- Не считать standalone `<wizard>` официальным grammar root: это explicit
  compatibility mode без каких-либо доказательств.
- Любая mutating language operation (rename, будущие edits) должна иметь тест
  на entities, CRLF и qualified `^Owner:Input^` токены.
- Не удалять unknown XML: lossless preservation — обязательная часть модуля.
- Не добавлять произвольный Node-only import в portable provider path.
- Runtime manifest импортирует compiled file из `dist`, а source runtime остаётся
  в `modules/.../runtime.js`; обычный `tsc` source runtime не копирует.
- `prettier` в текущем standalone workspace не установлен; форматирование
  проверять существующими project checks или доступным локальным formatter.
- `git diff --check` показывает только ожидаемые CRLF-to-LF warnings для
  некоторых уже изменённых файлов; не делай массовую нормализацию line endings.

## Чужие изменения в worktree

На момент передачи worktree не чистый. Помимо wizard-изменений присутствуют
изменения в models, data schema, map/cliffs, triggers, cutscene provider,
vendor archives и других тестах. Они принадлежат другим параллельным задачам.

Не использовать:

- `git reset --hard`;
- `git checkout -- ...`;
- массовое удаление untracked files;
- массовую нормализацию формата или line endings.

Изменять только файлы, относящиеся к wizard-задаче, если пользователь явно не
передал другой scope.

## Рекомендуемый первый запуск

```powershell
Set-Location 'C:/FILES/SC2Files/coding/modkit-extensions-blizzard'

pnpm --dir ./starcraft2 exec vitest run `
  modules/wizard/test/language.test.ts `
  modules/wizard/test/format.test.ts `
  modules/wizard/test/native.test.ts

pnpm exec tsc --pretty false --noEmit -p ./starcraft2/tsconfig.sc2-wizard.json
pnpm run contributions:check
pnpm run test:module-map
```

После этого прочитать implementation plan и выбрать один узкий backlog item.
Не переписывать provider целиком: текущий parser/analyzer/schema adapter уже
составляют рабочую базу и покрыты тестами.

## Definition of done для следующего этапа

Следующий агент может отметить очередной этап завершённым только если:

1. добавлены focused tests;
2. wizard typecheck проходит;
3. provider/codec runtime проходит smoke;
4. contribution/module-map checks проходят;
5. неизвестный syntax не теряется;
6. compatibility behavior явно отделён от strict behavior;
7. в handoff/plan записано, что доказано и что осталось гипотезой.
