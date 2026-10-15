# @modkitx/galaxy

Парсинг и анализ Galaxy скриптов StarCraft II.

## Возможности

- **Парсинг Galaxy** — полный AST через plaxtony-core
- **Извлечение catalog refs** — Unit, Abil, Actor, Upgrade, Behavior, Effect, Weapon, Race
- **Symbol table** — функции, переменные, структуры
- **#include директивы** — зависимости между файлами
- **Error-tolerant** — парсит даже с ошибками

## Установка

```bash
pnpm add @modkitx/galaxy
```

## Использование

```typescript
import { analyzeGalaxyScript } from '@modkitx/galaxy';
import { readFileSync } from 'fs';

const code = readFileSync('MyMod/Scripts/LibDPAN.galaxy', 'utf8');
const result = analyzeGalaxyScript('LibDPAN.galaxy', code);

console.log('Functions:', result.functions.length);
console.log('Variables:', result.variables.length);
console.log('Catalog refs:', result.catalogRefs);
```

### Catalog refs

```typescript
for (const ref of result.catalogRefs) {
  console.log(`${ref.catalog} → ${ref.entry}`);
  // Unit → Marine
  // Abil → Stimpack
  // Race → Terr
}
```

### Symbol table

```typescript
// Функции
for (const func of result.functions) {
  console.log(`${func.returnType} ${func.name}(${func.parameters.map(p => `${p.type} ${p.name}`).join(', ')})`);
}

// Переменные
for (const v of result.variables) {
  console.log(`${v.isConst ? 'const ' : ''}${v.type} ${v.name}`);
}
```

## Совместимость

- ✅ **Node.js** 18+
- ✅ **Браузер**
- ✅ **Electron**

## Зависимости

- `@modkitx/plaxtony-core` — Galaxy parser + Printer
