# pokeapi-mcp-server

An MCP server wrapping the [PokéAPI](https://pokeapi.co). Provides tools to look up Pokémon, moves, abilities, items, locations, evolutions, and more — directly from Claude or any MCP-compatible client.

## Features

- Full coverage of the PokéAPI — Pokémon, species, moves, abilities, items, types, locations, evolutions, berries, natures, and more
- Fuzzy name matching with autocorrect — misspell a name and the server will either fix it automatically or suggest the closest matches
- Paginated results for large lists (egg groups, growth rates, pokédexes, etc.)

## Tools

Each resource has two tools: a `list_*` tool for pagination and a `get_*` tool for full details.

| Category | List tool | Get tool |
|---|---|---|
| Pokémon | `list_pokemon` | `get_pokemon` |
| Species | `list_pokemon_species` | `get_pokemon_species` |
| Moves | `list_moves` | `get_move` |
| Abilities | `list_abilities` | `get_ability` |
| Items | `list_items` | `get_item` |
| Types | `list_types` | `get_type` |
| Berries | `list_berries` | `get_berry` |
| Locations | `list_locations` | `get_location` |
| Evolution chains | `list_evolution_chains` | `get_evolution_chain` |
| Generations | `list_generations` | `get_generation` |
| Natures | `list_natures` | `get_nature` |
| ... and more | | |

`get_pokemon` accepts an optional `move_learn_method` parameter (`level-up`, `machine`, `egg`, `tutor`, or `all`) to filter the moves list.

## Installation

```bash
npm install
npm run build
```

## Usage with Claude Code

Add to your MCP config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "pokeapi": {
      "command": "node",
      "args": ["/path/to/pokeapi-mcp-server/dist/index.js"]
    }
  }
}
```

## Development

```bash
npm run dev   # run with tsx (no build step)
npm run build # compile TypeScript
npm start     # run compiled output
```

## Data source

All data is fetched live from [pokeapi.co](https://pokeapi.co). No API key required.
