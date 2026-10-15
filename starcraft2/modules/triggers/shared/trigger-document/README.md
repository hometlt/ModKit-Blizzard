# @modkitx/triggers

Чтение и анализ библиотек триггеров StarCraft II (`TriggerLibs/*.xml`, `Triggers`).

## Возможности

- **Парсинг Trigger XML** — читает формат `.SC2Triggers` / `TriggerLibs/*.xml`
- **Строго типизированный JSON** — все элементы библиотеки в типизированном виде
- **Извлечение catalog refs** — находит ссылки на `Unit`, `Abil`, `Actor`, `Upgrade`, `Behavior`, `Effect`, `Weapon` и т.д.
- **Построение дерева** — events, conditions, actions, local variables для каждого Trigger

## Установка

```bash
pnpm add @modkitx/triggers
```

## Использование

### Чтение библиотеки триггеров

```typescript
import { readTriggerLibrary } from '@modkitx/triggers';
import { readFileSync } from 'fs';

const xml = readFileSync('MyMod/Triggers', 'utf8');
const result = await readTriggerLibrary(xml);

console.log('Library:', result.library.id);
console.log('Elements:', Object.keys(result.library.elements).length);
```

### Доступ к элементам

```typescript
// По ID
const trigger = result.library.elements['4A446B6A'];
if (trigger.type === 'Trigger') {
  console.log('Events:', trigger.events);
  console.log('Actions:', trigger.actions);
}

// Root items (элементы верхнего уровня)
for (const item of result.library.items) {
  console.log(item.type, item.id, item.name);
}
```

### Catalog refs

```typescript
// Все refs
for (const ref of result.allRefs) {
  console.log(`${ref.catalog} → ${ref.entry}`);
  // Abil → SpawnCaster1
  // Race → Neut
}

// По элементам
for (const [elementId, refs] of result.refsByElement) {
  console.log(`Element ${elementId} has ${refs.length} refs`);
}
```

### Типы элементов

```typescript
type ElementJson =
  | CategoryJson      // Категория (папка)
  | TriggerJson       // Триггер (Event/Condition/Action)
  | FunctionDefJson   // Определение функции
  | FunctionCallJson  // Вызов функции
  | VariableJson      // Переменная
  | ParamJson         // Параметр
  | ParamDefJson      // Определение параметра
  | PresetJson        // Preset (enum-like)
  | PresetValueJson   // Значение preset
  | LabelJson;        // Метка
```

## Структура JSON

```typescript
interface TriggerLibraryJson {
  id: string;
  name?: string;
  items: ElementJson[];           // Root items
  elements: Record<string, ElementJson>;  // Все элементы по ID
}

interface CatalogRef {
  catalog: string;   // Unit, Abil, Actor, Upgrade, Behavior, Effect, Weapon, Race...
  entry: string;     // ID записи в каталоге
  path: string;      // Путь внутри элемента
}
```

## Совместимость

- ✅ **Node.js** 18+
- ✅ **Браузер**
- ✅ **Electron**

## Зависимости

- `@modkitx/plaxtony-core` — парсер XML триггеров

## Сборка

```bash
pnpm build
```
