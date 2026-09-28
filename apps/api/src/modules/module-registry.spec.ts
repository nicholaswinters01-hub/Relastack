import {
  MODULES,
  MODULE_BY_KEY,
  MODULE_REGISTRY,
  findDependents,
  resolveDependencies,
  withIncludedModules,
} from '@platform/shared';
import { describe, expect, it } from 'vitest';

describe('module registry', () => {
  it('has a unique key per module', () => {
    const keys = MODULE_REGISTRY.map((module) => module.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('references only modules that exist', () => {
    for (const module of MODULE_REGISTRY) {
      for (const dependency of module.dependencies) {
        expect(MODULE_BY_KEY.has(dependency), `${module.key} -> ${dependency}`).toBe(true);
      }
    }
  });

  it('is free of dependency cycles', () => {
    // A cycle would make enable() loop forever. Failing here, in CI, is far
    // better than discovering it when a customer clicks Enable.
    for (const module of MODULE_REGISTRY) {
      expect(() => resolveDependencies(module.key)).not.toThrow();
    }
  });

  it('marks exactly one module as core', () => {
    const core = MODULE_REGISTRY.filter((module) => module.isCore);

    expect(core).toHaveLength(1);
    expect(core[0]?.key).toBe(MODULES.CORE);
  });

  it('gives core no dependencies', () => {
    // Core is the floor. Anything it depended on would have to be more
    // fundamental than the account itself.
    expect(MODULE_BY_KEY.get(MODULES.CORE)?.dependencies).toEqual([]);
  });

  describe('resolveDependencies', () => {
    it('returns nothing for a module with none', () => {
      expect(resolveDependencies(MODULES.CRM)).toEqual([]);
    });

    it('returns direct dependencies', () => {
      expect(resolveDependencies(MODULES.SCHEDULING)).toEqual([MODULES.CRM]);
    });

    it('excludes the module itself', () => {
      expect(resolveDependencies(MODULES.SCHEDULING)).not.toContain(MODULES.SCHEDULING);
    });

    it('returns them in an order safe to enable sequentially', () => {
      const order = resolveDependencies(MODULES.AUTOMATION);

      for (const [index, key] of order.entries()) {
        const definition = MODULE_BY_KEY.get(key)!;
        for (const dependency of definition.dependencies) {
          // Every prerequisite appears before the module that needs it.
          expect(order.indexOf(dependency)).toBeLessThan(index);
        }
      }
    });

    it('throws on an unknown module rather than returning nothing', () => {
      // Returning [] would let a typo silently enable nothing at all.
      expect(() => resolveDependencies('not_a_module' as never)).toThrow(/Unknown module/);
    });
  });

  describe('findDependents', () => {
    it('finds what would break if a module were turned off', () => {
      const dependents = findDependents(MODULES.CRM);

      expect(dependents).toContain(MODULES.SCHEDULING);
      expect(dependents).toContain(MODULES.AUTOMATION);
    });

    it('returns nothing for a module nothing depends on', () => {
      expect(findDependents(MODULES.REPORTING)).toEqual([]);
    });
  });

  describe('packs', () => {
    it('includes only modules that exist', () => {
      for (const module of MODULE_REGISTRY) {
        for (const included of module.includes) {
          expect(MODULE_BY_KEY.has(included), `${module.key} includes ${included}`).toBe(true);
        }
      }
    });

    it('lets only packs include anything', () => {
      for (const module of MODULE_REGISTRY.filter((entry) => entry.kind !== 'pack')) {
        expect(module.includes, module.key).toEqual([]);
      }
    });

    it('gives every included module a pack that brings it', () => {
      // One nobody brings could never be had at all.
      for (const module of MODULE_REGISTRY.filter((entry) => entry.kind === 'included')) {
        const bringers = MODULE_REGISTRY.filter((entry) => entry.includes.includes(module.key));
        expect(bringers.length, module.key).toBeGreaterThan(0);
      }
    });

    it('turns a pack into the modules it brings', () => {
      expect([...withIncludedModules([MODULES.CRM, MODULES.PEST_CONTROL])].sort()).toEqual(
        [MODULES.CRM, MODULES.FLEET, MODULES.INVENTORY, MODULES.PEST_CONTROL].sort(),
      );
    });

    it('adds nothing to modules that are not packs', () => {
      expect([...withIncludedModules([MODULES.CRM, MODULES.SCHEDULING])].sort()).toEqual(
        [MODULES.CRM, MODULES.SCHEDULING].sort(),
      );
    });
  });
});
