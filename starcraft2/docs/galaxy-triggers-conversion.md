# Galaxy ↔ Triggers conversion

Этот файл — короткая практическая карта конвертера. Подробная история предыдущих
итераций находится в `triggers-galaxy-conversion.md` в этом же каталоге.

## 1. Что делает конвертер

Конвертер поддерживает два направления:

- **Galaxy → Triggers**: разбирает Galaxy, восстанавливает редактируемые элементы
  TriggerData и сериализует их в XML `Triggers`.
- **Triggers → Galaxy**: читает XML `Triggers`, разрешает ссылки на функции,
  параметры и библиотеки и генерирует Galaxy header/script.

Публичная точка входа находится в
`starcraft2/modules/triggers/services/galaxy-conversion/service.js`; основные
экспорты — в `index.js`.

## 2. Как определяется карта или мод

Инструмент восстановления `restore-documents.mjs` определяет тип документа по
его содержимому, регистр символов в именах каталогов при этом не важен:

- карта содержит корневой `MapScript.galaxy` и не содержит библиотечных
  `Base.SC2Data/Lib<ID>.galaxy`;
- мод содержит один или несколько `Base.SC2Data/Lib<ID>.galaxy` и не содержит
  корневого `MapScript.galaxy`;
- наличие обеих форм считается неоднозначным и отклоняется;
- отсутствие обеих форм также является ошибкой.

Это правило относится к контейнеру документа. Сам текст Galaxy не позволяет
надёжно отличить карту от мода. Низкоуровневый API принимает явный
`documentKind: 'map' | 'library'`, когда вызывающая сторона уже знает контейнер.

## 3. Galaxy → Triggers

Путь преобразования выглядит так:

`Galaxy parser → AST и объявления → зависимости/библиотеки → сопоставление с
TriggerLib ScriptCode/templates → TriggerData model → XML Triggers`.

Парсер и таблицы объявлений дают структуру функций, переменных, выражений и типов.
Загруженные TriggerLib и Galaxy declarations используются для разрешения
нативных функций, параметров, preset-значений и dependency symbols. Затем
`g2t-*` модули сопоставляют AST с нативными шаблонами. Если точного безопасного
сопоставления нет, код сохраняется структурно; нельзя удалять выражение или
повторно вычислять вызов только ради красивого GUI-представления.

Особенно важное правило: нельзя создавать synthetic `lf_*` FunctionDef, если
для конструкции существует нативное представление загруженной TriggerLib.
Проверки покрывают, в частности, expression statements, unary/binary expressions,
for/loop patterns, compound assignment, break/StopLooping и служебные переменные.

## 4. Triggers → Galaxy

Путь преобразования выглядит так:

`Trigger XML → модель библиотек и ссылок → анализ trigger/function/parameter →
раскрытие нативных TriggerLib templates → Galaxy AST → Galaxy printer`.

SAX-reader сохраняет типы, параметры, `ScriptCode`, `SubFuncType`, локализованные
значения и ссылки. Перед генерацией валидируются ссылки и структура. Модули
`ttg-*` раскрывают загруженные шаблоны, формируют AST, согласуют имена и порядок
инициализации; printer создаёт header и script. Порядок root/category элементов
учитывается при runtime initialization.

## 5. Проверка

Из корня `modkit-extensions-blizzard`:

```powershell
pnpm exec tsc -p starcraft2/tsconfig.trigger-conversion.json --noEmit false
pnpm exec vitest run --config starcraft2/modules/triggers/test/vitest.conversion.config.mjs
```

Первый шаг собирает TypeScript-часть конвертера. Второй запускает conversion,
template, structured, startup, G2T/TTG, comparison и naming tests.

Корпусная проверка дополнительно сравнивает:

- нормализованный AST тел функций и сигнатуры;
- объявления и количество функций;
- полные function calls и регистрации trigger events;
- parser/declaration validation;
- отсутствие новых synthetic `lf_*` fallback calls;
- SHA-256 исходных документов и runtime snapshot до/после.

Основные команды внешнего корпуса:

```powershell
node C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/tools/verify-forward-map.mjs <map.SC2Map>
node C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/tools/run-module-corpus.mjs
node C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/tools/summarize-forward-fidelity.mjs
```

`restore-documents.mjs` создаёт новые восстановленные документы и поэтому не
нужен для обычного тестового прогона. Не запускайте его поверх результатов,
которые пользователь проверяет вручную; используйте новый output-каталог.

Эти проверки декларационные и структурные. Они не исполняют Galaxy в движке и
не заменяют открытие/компиляцию документа в StarCraft II Editor.

## 6. Где лежат файлы

| Purpose | Path |
|---|---|
| Converter facade | `starcraft2/modules/triggers/services/galaxy-conversion/service.js` и `index.js` |
| Galaxy → Triggers | `starcraft2/modules/triggers/services/galaxy-conversion/internal/galaxy-to-trigger.ts`, `g2t-*.ts` |
| Triggers → Galaxy | `starcraft2/modules/triggers/services/galaxy-conversion/internal/trigger-to-galaxy.ts`, `ttg-*.ts` |
| Dependencies and comparison | `starcraft2/modules/triggers/services/galaxy-conversion/internal/dependency-functions.ts`, `galaxy-comparison.ts` |
| Trigger XML model/validation | `starcraft2/modules/triggers/shared/trigger-document/` |
| Conversion tests | `starcraft2/modules/triggers/test/conversion/` |
| Focused G2T/TTG tests | `starcraft2/modules/triggers/test/mk2/src/core/` и `starcraft2/modules/galaxy/test/mk2/src/core/` |
| Repository fixtures | `starcraft2/modules/triggers/test/fixtures/`, `starcraft2/modules/triggers/test/mk2/test/core-fixtures/` |
| Compiled output | `starcraft2/dist/modules/triggers/services/galaxy-conversion/` |
| Restoration tools | `C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/tools/` |
| Original test maps/mods | `C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/originals/` и `recovery-inputs/` |
| Restored/generated documents | `C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/restored/` и `targeted-*/` |
| Reports | `C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/reports/` |
| Current fidelity audit | `C:/FILES/SC2Files/coding/artifacts/test-mods-vovan/reports/forward-fidelity-audit-2026-09-13.md` и `.json` |

## 7. Известные ограничения

- Старые и текущие TriggerLib templates всё ещё расходятся для семейств
  `UnitGroupLoop*`, `IntLoop*`, `UnitFilter` и `UnitFilterStr`.
- Некоторые старые empty-string значения неоднозначны: по имеющимся данным нельзя
  всегда отличить пустой литерал от отсутствующего localization key.
- У двух старых карт нет восстанавливаемых trigger identifiers, поэтому точные
  регистрации `TriggerCreate` нельзя доказать только по TriggerData/TriggerStrings.
- В последнем библиотечном аудите MIYY сгенерировал 30 XML-функций сверх
  reference Galaxy; их достижимость и отсутствие дублирующих регистраций ещё
  требуют отдельного доказательства.
- StarLight и Deity Wasp после восстановления ранее выдавали ошибки вида
  `Invalid trigger element reference`, `Orphaned trigger parameter` и ссылки на
  `Unknown`. После этой серии исправлений эти документы не были заново проверены
  в Editor, поэтому проблема не считается решённой.
- Старые восстановленные Star Party и STAR CRAFT Roleplay намеренно не
  перезаписывались. Исправления конвертера не изменяют уже созданные документы.
- Успешные unit tests, нулевые validation errors и совпавший SHA не доказывают
  эквивалентное выполнение Galaxy в StarCraft II.
