#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = 'https://pokeapi.co/api/v2';

// Endpoints that support name-based lookup and have a corresponding list
const NAMED_ENDPOINTS: Record<string, string> = {
  'pokemon': 'pokemon',
  'pokemon-species': 'pokemon-species',
  'move': 'move',
  'ability': 'ability',
  'item': 'item',
  'type': 'type',
  'berry': 'berry',
  'berry-firmness': 'berry-firmness',
  'berry-flavor': 'berry-flavor',
  'contest-type': 'contest-type',
  'encounter-method': 'encounter-method',
  'encounter-condition': 'encounter-condition',
  'encounter-condition-value': 'encounter-condition-value',
  'evolution-trigger': 'evolution-trigger',
  'generation': 'generation',
  'pokedex': 'pokedex',
  'version': 'version',
  'version-group': 'version-group',
  'item-attribute': 'item-attribute',
  'item-category': 'item-category',
  'item-fling-effect': 'item-fling-effect',
  'item-pocket': 'item-pocket',
  'location': 'location',
  'location-area': 'location-area',
  'pal-park-area': 'pal-park-area',
  'region': 'region',
  'move-ailment': 'move-ailment',
  'move-battle-style': 'move-battle-style',
  'move-category': 'move-category',
  'move-damage-class': 'move-damage-class',
  'move-learn-method': 'move-learn-method',
  'move-target': 'move-target',
  'nature': 'nature',
  'pokeathlon-stat': 'pokeathlon-stat',
  'pokemon-color': 'pokemon-color',
  'pokemon-form': 'pokemon-form',
  'pokemon-habitat': 'pokemon-habitat',
  'pokemon-shape': 'pokemon-shape',
  'egg-group': 'egg-group',
  'gender': 'gender',
  'growth-rate': 'growth-rate',
  'stat': 'stat',
  'language': 'language',
};

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

async function fetchNameList(endpoint: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/${endpoint}/?limit=10000`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.results as any[]).map((r: any) => r.name);
}

async function fetchPokeAPI(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (res.ok) return res.json();

  if (res.status === 404) {
    // Extract endpoint and name from path e.g. /pokemon/wobuffet/
    const parts = path.replace(/^\/|\/$/g, '').split('/');
    const endpoint = parts[0];
    const query = parts[1];

    if (query && !Number.isInteger(Number(query)) && NAMED_ENDPOINTS[endpoint]) {
      const names = await fetchNameList(endpoint);
      if (names.length > 0) {
        const scored = names.map(n => ({ name: n, dist: levenshtein(query.toLowerCase(), n.toLowerCase()) }));
        scored.sort((a, b) => a.dist - b.dist);
        const best = scored[0];

        // Only auto-correct if the edit distance is reasonable (≤ 1/3 of query length, min 3)
        const threshold = Math.max(3, Math.floor(query.length / 3));
        if (best.dist <= threshold) {
          const correctedPath = path.replace(`/${query}/`, `/${best.name}/`);
          const retryRes = await fetch(`${BASE_URL}${correctedPath}`);
          if (retryRes.ok) {
            const data = await retryRes.json() as any;
            data._autocorrected = { from: query, to: best.name };
            return data;
          }
        }

        // Suggest top 3 if no confident match
        const suggestions = scored.slice(0, 3).map(s => s.name);
        throw new Error(`Not found: "${query}". Did you mean: ${suggestions.join(', ')}?`);
      }
    }
  }

  throw new Error(`PokéAPI error ${res.status}: ${res.statusText} (${path})`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extract numeric ID from a PokeAPI URL
function extractId(url: string): string {
  return url.split('/').filter(Boolean).pop()!;
}

// Deduplicate flavor text entries: keep the latest entry per language
function dedupeFlavorText(entries: any[]): { language: string; flavor_text: string }[] {
  return Object.values(
    entries.reduce((acc: any, e: any) => {
      acc[e.language.name] = e;
      return acc;
    }, {})
  ).map((e: any) => ({ language: e.language.name, flavor_text: e.flavor_text }));
}

// Common mapping helpers
function mapNames(arr: any[]): { language: string; name: string }[] {
  return arr.map((n: any) => ({ language: n.language.name, name: n.name }));
}

function mapDescriptions(arr: any[]): { language: string; description: string }[] {
  return arr.map((d: any) => ({ language: d.language.name, description: d.description }));
}

function mapEffects(arr: any[]): { language: string; effect: string; short_effect: string }[] {
  return arr.map((e: any) => ({ language: e.language.name, effect: e.effect, short_effect: e.short_effect }));
}

function namedRef(arr: any[], idKey: string): Record<string, any>[] {
  return arr.map((x: any) => ({ name: x.name, [idKey]: extractId(x.url) }));
}

function toContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Schemas & server
// ---------------------------------------------------------------------------

const idOrNameSchema = {
  id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)')
};

const idOnlySchema = {
  id: z.number().describe('Numeric ID')
};

const listSchema = {
  limit: z.number().optional().describe('Number of results (default 20)'),
  offset: z.number().optional().describe('Offset for pagination (default 0)')
};

const server = new McpServer({
  name: 'pokeapi-mcp-server',
  version: '1.0.0'
});

function registerListTool(name: string, description: string, endpoint: string) {
  server.registerTool(name, { description, inputSchema: listSchema }, async ({ limit, offset }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString() ? `?${params}` : '';
    return toContent(await fetchPokeAPI(`/${endpoint}/${query}`));
  });
}

// ---------------------------------------------------------------------------
// Berries
// ---------------------------------------------------------------------------
registerListTool('list_berries', 'List all berries. Returns names — use get_berry for details including firmness, flavor, and held item.', 'berry');

server.registerTool('get_berry', { description: 'Get a berry by ID or name. firmness links to get_berry_firmness. flavors links to get_berry_flavor. natural_gift_type links to get_type. item links to get_item.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const b = await fetchPokeAPI(`/berry/${id}/`) as any;
  return toContent({
    id: b.id, name: b.name, growth_time: b.growth_time, max_harvest: b.max_harvest,
    natural_gift_power: b.natural_gift_power, size: b.size, smoothness: b.smoothness,
    soil_dryness: b.soil_dryness, firmness: b.firmness?.name ?? null,
    natural_gift_type: b.natural_gift_type?.name ?? null,
    item: b.item ? { name: b.item.name, item_id: extractId(b.item.url) } : null,
    flavors: b.flavors.map((f: any) => ({ flavor: f.flavor.name, potency: f.potency })),
    names: b.names ? mapNames(b.names) : []
  });
});

registerListTool('list_berry_firmnesses', 'List all berry firmnesses. Returns names — use get_berry_firmness for details.', 'berry-firmness');

server.registerTool('get_berry_firmness', { description: 'Get a berry firmness by ID or name. berries lists berries with this firmness — use get_berry for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const f = await fetchPokeAPI(`/berry-firmness/${id}/`) as any;
  return toContent({
    id: f.id, name: f.name,
    names: mapNames(f.names),
    berries: namedRef(f.berries, 'berry_id')
  });
});

registerListTool('list_berry_flavors', 'List all berry flavors. Returns names — use get_berry_flavor for details.', 'berry-flavor');

server.registerTool('get_berry_flavor', { description: 'Get a berry flavor by ID or name. contest_type links to get_contest_type. berries lists berries with this flavor — use get_berry for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const f = await fetchPokeAPI(`/berry-flavor/${id}/`) as any;
  return toContent({
    id: f.id, name: f.name,
    contest_type: f.contest_type?.name ?? null,
    names: mapNames(f.names),
    berries: f.berries.map((b: any) => ({ name: b.berry.name, potency: b.potency }))
  });
});

// ---------------------------------------------------------------------------
// Contests
// ---------------------------------------------------------------------------
registerListTool('list_contest_types', 'List all contest types. Returns names — use get_contest_type for details.', 'contest-type');

server.registerTool('get_contest_type', { description: 'Get a contest type by ID or name. berry_flavor links to get_berry_flavor.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/contest-type/${id}/`) as any;
  return toContent({
    id: c.id, name: c.name,
    berry_flavor: c.berry_flavor?.name ?? null,
    names: c.names.map((n: any) => ({ language: n.language.name, name: n.name, color: n.color }))
  });
});

registerListTool('list_contest_effects', 'List all contest effects. Returns IDs — use get_contest_effect for details.', 'contest-effect');

server.registerTool('get_contest_effect', { description: 'Get a contest effect by numeric ID. appeal and jam are the effect values.', inputSchema: idOnlySchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/contest-effect/${id}/`) as any;
  return toContent({
    id: c.id, appeal: c.appeal, jam: c.jam,
    effect_entries: c.effect_entries.map((e: any) => ({ language: e.language.name, effect: e.effect })),
    flavor_text_entries: dedupeFlavorText(c.flavor_text_entries)
  });
});

registerListTool('list_super_contest_effects', 'List all super contest effects. Returns IDs — use get_super_contest_effect for details.', 'super-contest-effect');

server.registerTool('get_super_contest_effect', { description: 'Get a super contest effect by numeric ID. moves lists moves with this effect — use move_id with get_move for details.', inputSchema: idOnlySchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/super-contest-effect/${id}/`) as any;
  return toContent({
    id: c.id, appeal: c.appeal,
    flavor_text_entries: dedupeFlavorText(c.flavor_text_entries),
    moves: namedRef(c.moves, 'move_id')
  });
});

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------
registerListTool('list_encounter_methods', 'List all encounter methods (e.g. walk, surf, fish). Returns names — use get_encounter_method for details.', 'encounter-method');

server.registerTool('get_encounter_method', { description: 'Get an encounter method by ID or name (e.g. walk, surf, old-rod).', inputSchema: idOrNameSchema }, async ({ id }) => {
  const e = await fetchPokeAPI(`/encounter-method/${id}/`) as any;
  return toContent({ id: e.id, name: e.name, order: e.order, names: mapNames(e.names) });
});

registerListTool('list_encounter_conditions', 'List all encounter conditions (e.g. time of day, season). Returns names — use get_encounter_condition for details.', 'encounter-condition');

server.registerTool('get_encounter_condition', { description: 'Get an encounter condition by ID or name. values lists condition values — use get_encounter_condition_value for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/encounter-condition/${id}/`) as any;
  return toContent({
    id: c.id, name: c.name,
    names: mapNames(c.names),
    values: namedRef(c.values, 'condition_value_id')
  });
});

registerListTool('list_encounter_condition_values', 'List all encounter condition values (e.g. day, night, spring). Returns names — use get_encounter_condition_value for details.', 'encounter-condition-value');

server.registerTool('get_encounter_condition_value', { description: 'Get an encounter condition value by ID or name. condition links to get_encounter_condition.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const v = await fetchPokeAPI(`/encounter-condition-value/${id}/`) as any;
  return toContent({
    id: v.id, name: v.name, is_default: v.is_default,
    condition: v.condition?.name ?? null,
    names: mapNames(v.names)
  });
});

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------
registerListTool('list_evolution_chains', 'List all evolution chains. Returns IDs — use get_evolution_chain for the full chain tree.', 'evolution-chain');

server.registerTool(
  'get_evolution_chain',
  {
    description: 'Get an evolution chain by ID. Returns a nested chain tree where each node has species.name — use get_pokemon_species with that name for species details, or get_pokemon for stats/moves/sprites. evolution_chain_id is returned by get_pokemon_species.',
    inputSchema: idOnlySchema
  },
  async ({ id }) => {
    const data = await fetchPokeAPI(`/evolution-chain/${id}/`) as any;

    function slimEvolutionDetails(details: any[]): any[] {
      return details.map((d: any) => {
        const out: Record<string, any> = {
          trigger: d.trigger?.name ?? null
        };
        if (d.min_level) out.min_level = d.min_level;
        if (d.min_happiness) out.min_happiness = d.min_happiness;
        if (d.min_affection) out.min_affection = d.min_affection;
        if (d.min_beauty) out.min_beauty = d.min_beauty;
        if (d.time_of_day) out.time_of_day = d.time_of_day;
        if (d.item) out.item = { name: d.item.name, item_id: extractId(d.item.url) };
        if (d.held_item) out.held_item = { name: d.held_item.name, item_id: extractId(d.held_item.url) };
        if (d.known_move) out.known_move = { name: d.known_move.name, move_id: extractId(d.known_move.url) };
        if (d.known_move_type) out.known_move_type = d.known_move_type.name;
        if (d.location) out.location = { name: d.location.name, location_id: extractId(d.location.url) };
        if (d.trade_species) out.trade_species = { name: d.trade_species.name, species_id: extractId(d.trade_species.url) };
        if (d.party_species) out.party_species = { name: d.party_species.name, species_id: extractId(d.party_species.url) };
        if (d.party_type) out.party_type = d.party_type.name;
        if (d.gender !== null && d.gender !== undefined) out.gender = d.gender;
        if (d.relative_physical_stats !== null && d.relative_physical_stats !== undefined) out.relative_physical_stats = d.relative_physical_stats;
        if (d.needs_overworld_rain) out.needs_overworld_rain = true;
        if (d.needs_multiplayer) out.needs_multiplayer = true;
        if (d.turn_upside_down) out.turn_upside_down = true;
        return out;
      });
    }

    function slimChain(link: any): any {
      return {
        species_name: link.species.name,
        species_id: extractId(link.species.url),
        evolution_details: slimEvolutionDetails(link.evolution_details),
        evolves_to: link.evolves_to.map(slimChain)
      };
    }

    return toContent({
      id: data.id,
      baby_trigger_item: data.baby_trigger_item?.name ?? null,
      chain: slimChain(data.chain)
    });
  }
);

registerListTool('list_evolution_triggers', 'List all evolution triggers (e.g. level-up, trade, use-item). Returns names — use get_evolution_trigger for details.', 'evolution-trigger');

server.registerTool(
  'get_evolution_trigger',
  {
    description: 'Get an evolution trigger by ID or name. pokemon_species lists species that evolve via this trigger — use species_id with get_pokemon_species for details. Use limit/offset to paginate.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      limit: z.number().optional().describe('Number of species to return (default: all)'),
      offset: z.number().optional().describe('Offset into species list (default: 0)')
    }
  },
  async ({ id, limit, offset = 0 }) => {
    const t = await fetchPokeAPI(`/evolution-trigger/${id}/`) as any;
    const species = t.pokemon_species.map((s: any) => ({
      name: s.name,
      species_id: extractId(s.url)
    }));
    const paginated = limit !== undefined ? species.slice(offset, offset + limit) : species.slice(offset);
    const slim = {
      id: t.id,
      name: t.name,
      names: mapNames(t.names),
      pokemon_species: paginated,
      total_species: t.pokemon_species.length,
      offset,
      ...(limit !== undefined && { limit })
    };
    return toContent(slim);
  }
);

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------
registerListTool('list_generations', 'List all generations. Returns names — use get_generation for the full list of Pokémon, moves, and abilities introduced in that generation.', 'generation');

server.registerTool(
  'get_generation',
  {
    description: 'Get a generation by ID or name. abilities lists ability names — use get_ability for details. moves lists move names — use get_move for details. pokemon_species lists species names — use get_pokemon_species for details. version_groups links to get_version_group.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const g = await fetchPokeAPI(`/generation/${id}/`) as any;
    const slim = {
      id: g.id,
      name: g.name,
      main_region: g.main_region.name,
      names: mapNames(g.names),
      version_groups: g.version_groups.map((v: any) => v.name),
      abilities: g.abilities.map((a: any) => a.name),
      moves: g.moves.map((m: any) => m.name),
      pokemon_species: g.pokemon_species.map((s: any) => s.name),
      types: g.types.map((t: any) => t.name)
    };
    return toContent(slim);
  }
);

registerListTool('list_pokedexes', 'List all pokédexes. Returns names — use get_pokedex for the full Pokémon entry list.', 'pokedex');

server.registerTool(
  'get_pokedex',
  {
    description: 'Get a pokédex by ID or name. pokemon_entries lists species names — use get_pokemon_species or get_pokemon with the name for details. Use limit/offset to paginate the entry list.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      limit: z.number().optional().describe('Number of pokemon entries to return (default: all)'),
      offset: z.number().optional().describe('Offset into pokemon entries (default: 0)')
    }
  },
  async ({ id, limit, offset = 0 }) => {
    const p = await fetchPokeAPI(`/pokedex/${id}/`) as any;
    const entries = p.pokemon_entries.map((e: any) => ({
      entry_number: e.entry_number,
      name: e.pokemon_species.name
    }));
    const paginated = limit !== undefined ? entries.slice(offset, offset + limit) : entries.slice(offset);
    const slim = {
      id: p.id,
      name: p.name,
      is_main_series: p.is_main_series,
      region: p.region?.name ?? null,
      version_groups: p.version_groups.map((v: any) => v.name),
      names: mapNames(p.names),
      descriptions: mapDescriptions(p.descriptions),
      pokemon_entries: paginated,
      total_entries: p.pokemon_entries.length,
      offset,
      ...(limit !== undefined && { limit })
    };
    return toContent(slim);
  }
);

registerListTool('list_versions', 'List all game versions (e.g. red, diamond). Returns names — use get_version for details.', 'version');

server.registerTool('get_version', { description: 'Get a game version by ID or name. version_group links to get_version_group for move learn methods, pokedexes, and region info.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const v = await fetchPokeAPI(`/version/${id}/`) as any;
  return toContent({
    id: v.id, name: v.name,
    version_group: v.version_group?.name ?? null,
    names: mapNames(v.names)
  });
});

registerListTool('list_version_groups', 'List all version groups (e.g. diamond-pearl). Returns names — use get_version_group for details.', 'version-group');

server.registerTool('get_version_group', { description: 'Get a version group by ID or name. generation links to get_generation. move_learn_methods links to get_move_learn_method. pokedexes links to get_pokedex. regions links to get_region. versions links to get_version.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const v = await fetchPokeAPI(`/version-group/${id}/`) as any;
  return toContent({
    id: v.id, name: v.name, order: v.order,
    generation: v.generation?.name ?? null,
    move_learn_methods: v.move_learn_methods.map((m: any) => m.name),
    pokedexes: v.pokedexes.map((p: any) => p.name),
    regions: v.regions.map((r: any) => r.name),
    versions: v.versions.map((ver: any) => ver.name)
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
registerListTool('list_items', 'List all items. Returns names — use get_item for details.', 'item');

server.registerTool(
  'get_item',
  {
    description: 'Get an item by ID or name. category links to get_item_category. fling_effect links to get_item_fling_effect. machines lists machine_ids — use get_machine for details. held_by_pokemon lists Pokémon that hold this item — use get_pokemon for details. attributes links to get_item_attribute.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const i = await fetchPokeAPI(`/item/${id}/`) as any;
    const slim = {
      id: i.id,
      name: i.name,
      cost: i.cost,
      fling_power: i.fling_power,
      fling_effect: i.fling_effect?.name ?? null,
      category: i.category?.name ?? null,
      attributes: i.attributes.map((a: any) => a.name),
      names: mapNames(i.names),
      effect_entries: mapEffects(i.effect_entries),
      flavor_text_entries: dedupeFlavorText(
        i.flavor_text_entries.map((e: any) => ({
          language: e.language,
          flavor_text: e.text,
          version_group: e.version_group?.name
        }))
      ),
      held_by_pokemon: i.held_by_pokemon.map((h: any) => ({
        name: h.pokemon.name, pokemon_id: extractId(h.pokemon.url)
      })),
      machines: i.machines.map((m: any) => ({
        machine_id: extractId(m.machine.url),
        version_group: m.version_group.name
      })),
      baby_trigger_for: i.baby_trigger_for
        ? { evolution_chain_id: extractId(i.baby_trigger_for.url) }
        : null,
      sprites: { default: i.sprites?.default ?? null }
    };
    return toContent(slim);
  }
);

registerListTool('list_item_attributes', 'List all item attributes (e.g. holdable, consumable). Returns names — use get_item_attribute for details.', 'item-attribute');

server.registerTool(
  'get_item_attribute',
  {
    description: 'Get an item attribute by ID or name. items lists items with this attribute — use item_id or the name with get_item for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const a = await fetchPokeAPI(`/item-attribute/${id}/`) as any;
    return toContent({
      id: a.id, name: a.name,
      names: mapNames(a.names),
      descriptions: mapDescriptions(a.descriptions),
      items: namedRef(a.items, 'item_id')
    });
  }
);

registerListTool('list_item_categories', 'List all item categories. Returns names — use get_item_category for details.', 'item-category');

server.registerTool(
  'get_item_category',
  {
    description: 'Get an item category by ID or name. items lists items in this category — use item_id or the name with get_item for details. pocket links to get_item_pocket.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const c = await fetchPokeAPI(`/item-category/${id}/`) as any;
    return toContent({
      id: c.id, name: c.name,
      names: mapNames(c.names),
      pocket: c.pocket.name,
      items: namedRef(c.items, 'item_id')
    });
  }
);

registerListTool('list_item_fling_effects', 'List all item fling effects. Returns names — use get_item_fling_effect for details.', 'item-fling-effect');

server.registerTool(
  'get_item_fling_effect',
  {
    description: 'Get an item fling effect by ID or name. items lists items with this fling effect — use item_id or the name with get_item for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const f = await fetchPokeAPI(`/item-fling-effect/${id}/`) as any;
    return toContent({
      id: f.id, name: f.name,
      effect_entries: f.effect_entries.map((e: any) => ({ language: e.language.name, effect: e.effect })),
      items: namedRef(f.items, 'item_id')
    });
  }
);

registerListTool('list_item_pockets', 'List all item pockets (bag sections). Returns names — use get_item_pocket for details.', 'item-pocket');

server.registerTool('get_item_pocket', { description: 'Get an item pocket by ID or name. categories lists item categories in this pocket — use get_item_category for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const p = await fetchPokeAPI(`/item-pocket/${id}/`) as any;
  return toContent({
    id: p.id, name: p.name,
    names: mapNames(p.names),
    categories: namedRef(p.categories, 'category_id')
  });
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
registerListTool('list_locations', 'List all locations. Returns names — use get_location for details including sub-areas.', 'location');

server.registerTool('get_location', { description: 'Get a location by ID or name. region links to get_region. areas lists sub-areas — use area_id with get_location_area for encounter details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const l = await fetchPokeAPI(`/location/${id}/`) as any;
  return toContent({
    id: l.id, name: l.name,
    region: l.region?.name ?? null,
    names: mapNames(l.names),
    areas: namedRef(l.areas, 'area_id')
  });
});

registerListTool('list_location_areas', 'List all location areas. Returns names — use get_location_area for encounter details.', 'location-area');

server.registerTool('get_location_area', { description: 'Get a location area by ID or name. location links to get_location. pokemon_encounters lists Pokémon found here — use pokemon_id with get_pokemon for details. encounter_method_rates references get_encounter_method.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const a = await fetchPokeAPI(`/location-area/${id}/`) as any;
  return toContent({
    id: a.id, name: a.name, game_index: a.game_index,
    location: a.location ? { name: a.location.name, location_id: extractId(a.location.url) } : null,
    names: mapNames(a.names),
    encounter_method_rates: a.encounter_method_rates.map((r: any) => ({
      method: r.encounter_method.name,
      version_rates: r.version_details.map((v: any) => ({ version: v.version.name, rate: v.rate }))
    })),
    pokemon_encounters: a.pokemon_encounters.map((e: any) => ({
      name: e.pokemon.name,
      pokemon_id: extractId(e.pokemon.url),
      version_details: e.version_details.map((v: any) => ({
        version: v.version.name,
        max_chance: v.max_chance,
        encounter_details: v.encounter_details.map((d: any) => ({
          min_level: d.min_level, max_level: d.max_level, chance: d.chance,
          method: d.method.name,
          condition_values: d.condition_values.map((c: any) => c.name)
        }))
      }))
    }))
  });
});

registerListTool('list_pal_park_areas', 'List all Pal Park areas. Returns names — use get_pal_park_area for details.', 'pal-park-area');

server.registerTool(
  'get_pal_park_area',
  {
    description: 'Get a Pal Park area by ID or name. pokemon_encounters lists Pokémon found here — use species_id with get_pokemon_species for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const p = await fetchPokeAPI(`/pal-park-area/${id}/`) as any;
    return toContent({
      id: p.id, name: p.name,
      names: mapNames(p.names),
      pokemon_encounters: p.pokemon_encounters.map((e: any) => ({
        name: e.pokemon_species.name,
        species_id: extractId(e.pokemon_species.url),
        score: e.score,
        rate: e.rate
      }))
    });
  }
);

registerListTool('list_regions', 'List all regions (e.g. kanto, sinnoh). Returns names — use get_region for details.', 'region');

server.registerTool('get_region', { description: 'Get a region by ID or name. locations lists locations in this region — use location_id with get_location for details. main_generation links to get_generation. pokedexes links to get_pokedex. version_groups links to get_version_group.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const r = await fetchPokeAPI(`/region/${id}/`) as any;
  return toContent({
    id: r.id, name: r.name,
    main_generation: r.main_generation?.name ?? null,
    names: mapNames(r.names),
    locations: namedRef(r.locations, 'location_id'),
    pokedexes: r.pokedexes.map((p: any) => p.name),
    version_groups: r.version_groups.map((v: any) => v.name)
  });
});

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------
registerListTool('list_machines', 'List all machines (TMs/HMs). Returns IDs — use get_machine for details.', 'machine');

server.registerTool('get_machine', { description: 'Get a machine (TM/HM) by numeric ID. item links to get_item. move links to get_move. version_group links to get_version_group.', inputSchema: idOnlySchema }, async ({ id }) => {
  const m = await fetchPokeAPI(`/machine/${id}/`) as any;
  return toContent({
    id: m.id,
    item: m.item ? { name: m.item.name, item_id: extractId(m.item.url) } : null,
    move: m.move ? { name: m.move.name, move_id: extractId(m.move.url) } : null,
    version_group: m.version_group?.name ?? null
  });
});

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------
registerListTool('list_moves', 'List all moves. Returns names — use get_move for details.', 'move');

server.registerTool(
  'get_move',
  {
    description: 'Get a move by ID or name. type links to get_type. damage_class links to get_move_damage_class. target links to get_move_target. contest_type links to get_contest_type. learned_by_pokemon lists Pokémon that can learn this move — use pokemon_id with get_pokemon for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const m = await fetchPokeAPI(`/move/${id}/`) as any;
    const slim = {
      id: m.id,
      name: m.name,
      accuracy: m.accuracy,
      effect_chance: m.effect_chance,
      pp: m.pp,
      priority: m.priority,
      power: m.power,
      damage_class: m.damage_class?.name,
      type: m.type?.name,
      target: m.target?.name,
      generation: m.generation?.name,
      meta: m.meta,
      contest_type: m.contest_type?.name,
      names: mapNames(m.names),
      effect_entries: mapEffects(m.effect_entries),
      flavor_text_entries: dedupeFlavorText(m.flavor_text_entries),
      learned_by_pokemon: namedRef(m.learned_by_pokemon, 'pokemon_id')
    };
    return toContent(slim);
  }
);

registerListTool('list_move_ailments', 'List all move ailments (e.g. poison, paralysis). Returns names — use get_move_ailment for details.', 'move-ailment');

server.registerTool('get_move_ailment', { description: 'Get a move ailment by ID or name. moves lists moves that cause this ailment — use move_id with get_move for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const a = await fetchPokeAPI(`/move-ailment/${id}/`) as any;
  return toContent({
    id: a.id, name: a.name,
    names: mapNames(a.names),
    moves: namedRef(a.moves, 'move_id')
  });
});

registerListTool('list_move_battle_styles', 'List all move battle styles. Returns names — use get_move_battle_style for details.', 'move-battle-style');

server.registerTool('get_move_battle_style', { description: 'Get a move battle style by ID or name.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const b = await fetchPokeAPI(`/move-battle-style/${id}/`) as any;
  return toContent({ id: b.id, name: b.name, names: mapNames(b.names) });
});

registerListTool('list_move_categories', 'List all move categories (e.g. damage, ailment, heal). Returns names — use get_move_category for details.', 'move-category');

server.registerTool('get_move_category', { description: 'Get a move category by ID or name. moves lists moves in this category — use move_id with get_move for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/move-category/${id}/`) as any;
  return toContent({
    id: c.id, name: c.name,
    descriptions: mapDescriptions(c.descriptions),
    moves: namedRef(c.moves, 'move_id')
  });
});

registerListTool('list_move_damage_classes', 'List all move damage classes (physical, special, status). Returns names — use get_move_damage_class for details.', 'move-damage-class');

server.registerTool('get_move_damage_class', { description: 'Get a move damage class by ID or name (physical, special, status). moves lists moves in this class — use move_id with get_move for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const d = await fetchPokeAPI(`/move-damage-class/${id}/`) as any;
  return toContent({
    id: d.id, name: d.name,
    names: mapNames(d.names),
    descriptions: mapDescriptions(d.descriptions),
    moves: namedRef(d.moves, 'move_id')
  });
});

registerListTool('list_move_learn_methods', 'List all move learn methods (level-up, egg, tutor, machine). Returns names — use get_move_learn_method for details.', 'move-learn-method');

server.registerTool('get_move_learn_method', { description: 'Get a move learn method by ID or name. version_groups lists version groups where this method exists — use get_version_group for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const m = await fetchPokeAPI(`/move-learn-method/${id}/`) as any;
  return toContent({
    id: m.id, name: m.name,
    names: mapNames(m.names),
    descriptions: mapDescriptions(m.descriptions),
    version_groups: m.version_groups.map((v: any) => v.name)
  });
});

registerListTool('list_move_targets', 'List all move targets (e.g. selected-pokemon, all-opponents). Returns names — use get_move_target for details.', 'move-target');

server.registerTool('get_move_target', { description: 'Get a move target by ID or name. moves lists moves with this target — use move_id with get_move for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const t = await fetchPokeAPI(`/move-target/${id}/`) as any;
  return toContent({
    id: t.id, name: t.name,
    names: mapNames(t.names),
    descriptions: mapDescriptions(t.descriptions),
    moves: namedRef(t.moves, 'move_id')
  });
});

// ---------------------------------------------------------------------------
// Pokémon
// ---------------------------------------------------------------------------
registerListTool('list_abilities', 'List all abilities. Returns names — use get_ability for effect details and which Pokémon have it.', 'ability');

server.registerTool(
  'get_ability',
  {
    description: 'Get an ability by ID or name. generation links to get_generation. pokemon lists Pokémon with this ability — use pokemon_id with get_pokemon for full details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const a = await fetchPokeAPI(`/ability/${id}/`) as any;
    const slim = {
      id: a.id,
      name: a.name,
      is_main_series: a.is_main_series,
      generation: a.generation.name,
      names: mapNames(a.names),
      effect_entries: mapEffects(a.effect_entries),
      flavor_text_entries: dedupeFlavorText(a.flavor_text_entries),
      pokemon: a.pokemon.map((p: any) => ({
        name: p.pokemon.name,
        pokemon_id: extractId(p.pokemon.url),
        is_hidden: p.is_hidden,
        slot: p.slot
      }))
    };
    return toContent(slim);
  }
);

registerListTool('list_characteristics', 'List all characteristics (IV-based personality descriptions). Returns IDs — use get_characteristic for details.', 'characteristic');

server.registerTool('get_characteristic', { description: 'Get a characteristic by numeric ID. highest_stat links to get_stat. Characteristics describe a Pokémon\'s highest IV as a personality trait.', inputSchema: idOnlySchema }, async ({ id }) => {
  const c = await fetchPokeAPI(`/characteristic/${id}/`) as any;
  return toContent({
    id: c.id, gene_modulo: c.gene_modulo, possible_values: c.possible_values,
    highest_stat: c.highest_stat?.name ?? null,
    descriptions: mapDescriptions(c.descriptions)
  });
});

registerListTool('list_egg_groups', 'List all egg groups. Returns names — use get_egg_group for the list of compatible species.', 'egg-group');

server.registerTool(
  'get_egg_group',
  {
    description: 'Get an egg group by ID or name. pokemon_species lists species that belong to this egg group — use species_id with get_pokemon_species for details. Use limit/offset to paginate the species list.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      limit: z.number().optional().describe('Number of species to return (default: all)'),
      offset: z.number().optional().describe('Offset into species list (default: 0)')
    }
  },
  async ({ id, limit, offset = 0 }) => {
    const g = await fetchPokeAPI(`/egg-group/${id}/`) as any;
    const species = g.pokemon_species.map((s: any) => ({
      name: s.name,
      species_id: extractId(s.url)
    }));
    const paginated = limit !== undefined ? species.slice(offset, offset + limit) : species.slice(offset);
    const slim = {
      id: g.id,
      name: g.name,
      names: mapNames(g.names),
      pokemon_species: paginated,
      total_species: g.pokemon_species.length,
      offset,
      ...(limit !== undefined && { limit })
    };
    return toContent(slim);
  }
);

registerListTool('list_genders', 'List all genders. Returns names — use get_gender for species lists and evolution requirements.', 'gender');

server.registerTool(
  'get_gender',
  {
    description: 'Get a gender by ID or name. pokemon_species_details lists species with their gender rates — use species_id with get_pokemon_species for details. required_for_evolution lists species that require this gender to evolve. Use limit/offset to paginate.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      limit: z.number().optional().describe('Number of species entries to return (default: all)'),
      offset: z.number().optional().describe('Offset into species entries (default: 0)')
    }
  },
  async ({ id, limit, offset = 0 }) => {
    const g = await fetchPokeAPI(`/gender/${id}/`) as any;
    const details = g.pokemon_species_details.map((e: any) => ({
      name: e.pokemon_species.name,
      species_id: extractId(e.pokemon_species.url),
      rate: e.rate
    }));
    const paginated = limit !== undefined ? details.slice(offset, offset + limit) : details.slice(offset);
    const slim = {
      id: g.id,
      name: g.name,
      required_for_evolution: namedRef(g.required_for_evolution, 'species_id'),
      pokemon_species_details: paginated,
      total_species: g.pokemon_species_details.length,
      offset,
      ...(limit !== undefined && { limit })
    };
    return toContent(slim);
  }
);

registerListTool('list_growth_rates', 'List all growth rates (how fast a Pokémon gains experience). Returns names — use get_growth_rate for the XP curve and species list.', 'growth-rate');

server.registerTool(
  'get_growth_rate',
  {
    description: 'Get a growth rate by ID or name. levels lists the XP required at each level. pokemon_species lists species with this growth rate — use species_id with get_pokemon_species for details. Use limit/offset to paginate the species list.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      limit: z.number().optional().describe('Number of species to return (default: all)'),
      offset: z.number().optional().describe('Offset into species list (default: 0)')
    }
  },
  async ({ id, limit, offset = 0 }) => {
    const g = await fetchPokeAPI(`/growth-rate/${id}/`) as any;
    const species = g.pokemon_species.map((s: any) => ({
      name: s.name,
      species_id: extractId(s.url)
    }));
    const paginated = limit !== undefined ? species.slice(offset, offset + limit) : species.slice(offset);
    const slim = {
      id: g.id,
      name: g.name,
      formula: g.formula,
      descriptions: mapDescriptions(g.descriptions),
      levels: g.levels,
      pokemon_species: paginated,
      total_species: g.pokemon_species.length,
      offset,
      ...(limit !== undefined && { limit })
    };
    return toContent(slim);
  }
);

registerListTool('list_natures', 'List all natures. Returns names — use get_nature for stat modifiers and flavor preferences.', 'nature');

server.registerTool('get_nature', { description: 'Get a nature by ID or name. increased_stat and decreased_stat link to get_stat. likes_flavor and hates_flavor link to get_berry_flavor. pokeathlon_stat_changes links to get_pokeathlon_stat.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const n = await fetchPokeAPI(`/nature/${id}/`) as any;
  return toContent({
    id: n.id, name: n.name,
    increased_stat: n.increased_stat?.name ?? null,
    decreased_stat: n.decreased_stat?.name ?? null,
    likes_flavor: n.likes_flavor?.name ?? null,
    hates_flavor: n.hates_flavor?.name ?? null,
    names: mapNames(n.names),
    pokeathlon_stat_changes: n.pokeathlon_stat_changes.map((c: any) => ({ stat: c.pokeathlon_stat.name, max_change: c.max_change })),
    move_battle_style_preferences: n.move_battle_style_preferences.map((p: any) => ({
      style: p.move_battle_style.name, low_hp_preference: p.low_hp_preference, high_hp_preference: p.high_hp_preference
    }))
  });
});

registerListTool('list_pokeathlon_stats', 'List all Pokéathlon stats. Returns names — use get_pokeathlon_stat for details.', 'pokeathlon-stat');

server.registerTool('get_pokeathlon_stat', { description: 'Get a Pokéathlon stat by ID or name. affecting_natures lists natures that raise or lower this stat — use get_nature for details.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const s = await fetchPokeAPI(`/pokeathlon-stat/${id}/`) as any;
  return toContent({
    id: s.id, name: s.name,
    names: mapNames(s.names),
    affecting_natures: {
      increase: s.affecting_natures.increase.map((n: any) => ({ nature: n.nature.name, max_change: n.max_change })),
      decrease: s.affecting_natures.decrease.map((n: any) => ({ nature: n.nature.name, max_change: n.max_change }))
    }
  });
});

registerListTool('list_pokemon', 'List all Pokémon. Returns names and IDs — use get_pokemon for stats, moves, abilities, and sprites. Use get_pokemon_species for lore and evolution info. Note: there is no way to sort or filter Pokémon by stat value — to find strong attackers, start with get_ability (e.g. huge-power, pure-power) or get_type to narrow candidates, then verify with get_pokemon.', 'pokemon');

server.registerTool(
  'get_pokemon',
  {
    description: 'Get a Pokémon by ID or name. Returns stats, abilities, moves, and sprites. abilities link to get_ability. types link to get_type. moves link to get_move. species links to get_pokemon_species for lore, egg groups, and evolution chain. moves is filtered to level-up moves only by default — set move_learn_method to "machine", "egg", "tutor", or "all" to see other moves.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('ID (number) or name (string)'),
      move_learn_method: z.enum(['level-up', 'machine', 'egg', 'tutor', 'all']).optional().describe('Filter moves by learn method (default: level-up)')
    }
  },
  async ({ id, move_learn_method = 'level-up' }) => {
    const p = await fetchPokeAPI(`/pokemon/${id}/`) as any;
    const allMoves = p.moves.map((m: any) => ({
      name: m.move.name,
      learn_methods: [...new Set(m.version_group_details.map((v: any) => v.move_learn_method.name))] as string[]
    }));
    const filteredMoves = move_learn_method === 'all'
      ? allMoves
      : allMoves.filter((m: any) => m.learn_methods.includes(move_learn_method));
    const slim = {
      id: p.id,
      name: p.name,
      height: p.height,
      weight: p.weight,
      base_experience: p.base_experience,
      types: p.types.map((t: any) => t.type.name),
      abilities: p.abilities.map((a: any) => ({ name: a.ability.name, is_hidden: a.is_hidden })),
      stats: p.stats.map((s: any) => ({ name: s.stat.name, base_stat: s.base_stat })),
      sprites: { front_default: p.sprites.front_default },
      species: {
        name: p.species.name,
        species_id: extractId(p.species.url)
      },
      moves: filteredMoves,
      moves_filter_applied: move_learn_method,
      total_moves: allMoves.length
    };
    return toContent(slim);
  }
);

server.registerTool(
  'get_pokemon_location_areas',
  {
    description: 'Get location areas where a Pokémon can be encountered. Returns location_area names — use get_location_area for encounter method details and full location info.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const data = await fetchPokeAPI(`/pokemon/${id}/encounters`) as any[];
    const slim = data.map((e: any) => ({
      location_area: e.location_area.name,
      location_area_id: extractId(e.location_area.url),
      version_details: e.version_details.map((v: any) => ({
        version: v.version.name,
        max_chance: v.max_chance,
        encounter_details: v.encounter_details.map((d: any) => ({
          min_level: d.min_level,
          max_level: d.max_level,
          chance: d.chance,
          method: d.method.name,
          condition_values: d.condition_values.map((c: any) => c.name)
        }))
      }))
    }));
    return toContent(slim);
  }
);

registerListTool('list_pokemon_colors', 'List all Pokémon colors. Returns names — use get_pokemon_color for the list of species with that color.', 'pokemon-color');

server.registerTool(
  'get_pokemon_color',
  {
    description: 'Get a Pokémon color by ID or name. pokemon_species lists species with this color — use species_id with get_pokemon_species for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const c = await fetchPokeAPI(`/pokemon-color/${id}/`) as any;
    return toContent({
      id: c.id, name: c.name,
      names: mapNames(c.names),
      pokemon_species: namedRef(c.pokemon_species, 'species_id')
    });
  }
);

registerListTool('list_pokemon_forms', 'List all Pokémon forms. Returns names — use get_pokemon_form for details.', 'pokemon-form');

server.registerTool('get_pokemon_form', { description: 'Get a Pokémon form by ID or name. pokemon links to get_pokemon with pokemon_id. version_group links to get_version_group.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const f = await fetchPokeAPI(`/pokemon-form/${id}/`) as any;
  return toContent({
    id: f.id, name: f.name, order: f.order, form_order: f.form_order,
    is_default: f.is_default, is_battle_only: f.is_battle_only, is_mega: f.is_mega,
    form_name: f.form_name,
    pokemon: f.pokemon ? { name: f.pokemon.name, pokemon_id: extractId(f.pokemon.url) } : null,
    version_group: f.version_group?.name ?? null,
    types: f.types?.map((t: any) => t.type.name) ?? [],
    names: f.form_names ? mapNames(f.form_names) : [],
    sprites: { front_default: f.sprites?.front_default ?? null }
  });
});

registerListTool('list_pokemon_habitats', 'List all Pokémon habitats (e.g. cave, forest, sea). Returns names — use get_pokemon_habitat for the species list.', 'pokemon-habitat');

server.registerTool(
  'get_pokemon_habitat',
  {
    description: 'Get a Pokémon habitat by ID or name. pokemon_species lists species found in this habitat — use species_id with get_pokemon_species for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const h = await fetchPokeAPI(`/pokemon-habitat/${id}/`) as any;
    return toContent({
      id: h.id, name: h.name,
      names: mapNames(h.names),
      pokemon_species: namedRef(h.pokemon_species, 'species_id')
    });
  }
);

registerListTool('list_pokemon_shapes', 'List all Pokémon shapes (e.g. quadruped, humanoid). Returns names — use get_pokemon_shape for the species list.', 'pokemon-shape');

server.registerTool(
  'get_pokemon_shape',
  {
    description: 'Get a Pokémon shape by ID or name. pokemon_species lists species with this shape — use species_id with get_pokemon_species for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const sh = await fetchPokeAPI(`/pokemon-shape/${id}/`) as any;
    return toContent({
      id: sh.id, name: sh.name,
      names: mapNames(sh.names),
      awesome_names: sh.awesome_names.map((n: any) => ({ language: n.language.name, awesome_name: n.awesome_name })),
      pokemon_species: namedRef(sh.pokemon_species, 'species_id')
    });
  }
);

registerListTool('list_pokemon_species', 'List all Pokémon species. Returns names — use get_pokemon_species for lore, egg groups, and evolution chain. Use get_pokemon for stats, moves, and sprites.', 'pokemon-species');

server.registerTool(
  'get_pokemon_species',
  {
    description: 'Get a Pokémon species by ID or name. Returns lore, egg groups, growth rate, and evolution info. Use get_pokemon with the same name for form-level data (stats, moves, sprites). Use get_evolution_chain with evolution_chain_id for the full evolution tree. evolves_from_species links to get_pokemon_species. growth_rate links to get_growth_rate. egg_groups links to get_egg_group.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const s = await fetchPokeAPI(`/pokemon-species/${id}/`) as any;
    const slim = {
      id: s.id,
      name: s.name,
      order: s.order,
      gender_rate: s.gender_rate,
      capture_rate: s.capture_rate,
      base_happiness: s.base_happiness,
      is_baby: s.is_baby,
      is_legendary: s.is_legendary,
      is_mythical: s.is_mythical,
      hatch_counter: s.hatch_counter,
      has_gender_differences: s.has_gender_differences,
      forms_switchable: s.forms_switchable,
      growth_rate: s.growth_rate?.name,
      egg_groups: s.egg_groups.map((e: any) => e.name),
      color: s.color?.name,
      shape: s.shape?.name,
      habitat: s.habitat?.name,
      generation: s.generation?.name,
      evolves_from_species: s.evolves_from_species?.name ?? null,
      evolution_chain_id: s.evolution_chain?.url ? extractId(s.evolution_chain.url) : null,
      names: mapNames(s.names),
      genera: s.genera.map((g: any) => ({ language: g.language.name, genus: g.genus })),
      flavor_text_entries: dedupeFlavorText(s.flavor_text_entries),
      varieties: s.varieties.map((v: any) => ({ name: v.pokemon.name, is_default: v.is_default })),
      pokedex_numbers: s.pokedex_numbers.map((p: any) => ({ pokedex: p.pokedex.name, entry_number: p.entry_number }))
    };
    return toContent(slim);
  }
);

registerListTool('list_stats', 'List all base stats (hp, attack, defense, etc.). Returns names — use get_stat for details.', 'stat');

server.registerTool(
  'get_stat',
  {
    description: 'Get a stat by ID or name. affecting_moves lists moves that raise or lower this stat — use move_id with get_move for details. affecting_natures lists natures that boost or reduce this stat — use get_nature for details. characteristics lists characteristic IDs — use get_characteristic for descriptions.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const s = await fetchPokeAPI(`/stat/${id}/`) as any;
    const slim = {
      id: s.id,
      name: s.name,
      is_battle_only: s.is_battle_only,
      game_index: s.game_index,
      move_damage_class: s.move_damage_class?.name ?? null,
      names: mapNames(s.names),
      affecting_moves: {
        increase: s.affecting_moves.increase.map((e: any) => ({ change: e.change, name: e.move.name, move_id: extractId(e.move.url) })),
        decrease: s.affecting_moves.decrease.map((e: any) => ({ change: e.change, name: e.move.name, move_id: extractId(e.move.url) }))
      },
      affecting_natures: {
        increase: s.affecting_natures.increase.map((n: any) => ({ name: n.name, nature_id: extractId(n.url) })),
        decrease: s.affecting_natures.decrease.map((n: any) => ({ name: n.name, nature_id: extractId(n.url) }))
      },
      affecting_items: s.affecting_items?.map((i: any) => ({ name: i.name, item_id: extractId(i.url) })) ?? [],
      characteristics: s.characteristics.map((c: any) => ({ characteristic_id: extractId(c.url) }))
    };
    return toContent(slim);
  }
);

registerListTool('list_types', 'List all Pokémon types (fire, water, grass, etc.). Returns names — use get_type for damage relations and Pokémon/move lists.', 'type');

server.registerTool(
  'get_type',
  {
    description: 'Get a Pokémon type by ID or name. damage_relations shows type effectiveness (double/half/no damage to and from). moves lists move names of this type — use get_move for details. pokemon lists Pokémon of this type — use pokemon_id with get_pokemon for details.',
    inputSchema: idOrNameSchema
  },
  async ({ id }) => {
    const t = await fetchPokeAPI(`/type/${id}/`) as any;
    const slim = {
      id: t.id,
      name: t.name,
      generation: t.generation?.name,
      move_damage_class: t.move_damage_class?.name,
      names: mapNames(t.names),
      damage_relations: {
        no_damage_to: t.damage_relations.no_damage_to.map((x: any) => x.name),
        half_damage_to: t.damage_relations.half_damage_to.map((x: any) => x.name),
        double_damage_to: t.damage_relations.double_damage_to.map((x: any) => x.name),
        no_damage_from: t.damage_relations.no_damage_from.map((x: any) => x.name),
        half_damage_from: t.damage_relations.half_damage_from.map((x: any) => x.name),
        double_damage_from: t.damage_relations.double_damage_from.map((x: any) => x.name)
      },
      moves: namedRef(t.moves, 'move_id'),
      pokemon: t.pokemon.map((p: any) => ({
        name: p.pokemon.name,
        pokemon_id: extractId(p.pokemon.url),
        slot: p.slot
      }))
    };
    return toContent(slim);
  }
);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
registerListTool('list_languages', 'List all languages supported by the API. Returns names — use get_language for details.', 'language');

server.registerTool('get_language', { description: 'Get a language by ID or name. Language codes appear throughout the API in multilingual name/flavor_text arrays.', inputSchema: idOrNameSchema }, async ({ id }) => {
  const l = await fetchPokeAPI(`/language/${id}/`) as any;
  return toContent({
    id: l.id, name: l.name,
    official: l.official, iso639: l.iso639, iso3166: l.iso3166,
    names: mapNames(l.names)
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
