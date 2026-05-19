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

## Running the server

The server speaks the MCP **Streamable HTTP** transport. Start it and point an MCP client at the HTTP endpoint.

```bash
npm start                              # http://127.0.0.1:3000/mcp
PORT=4000 npm start                    # custom port
HOST=0.0.0.0 npm start                 # bind all interfaces (intended for fronting behind another service)
ALLOWED_HOSTS=mcp.example.com npm start  # restrict Host header when not on localhost
```

| Env var         | Default       | Purpose                                                                     |
|-----------------|---------------|-----------------------------------------------------------------------------|
| `PORT`          | `3000`        | TCP port to listen on.                                                      |
| `HOST`          | `127.0.0.1`   | Bind address. Localhost values auto-enable DNS rebinding protection.        |
| `ALLOWED_HOSTS` | _(unset)_     | Comma-separated allowlist of `Host` header values. Use when binding `0.0.0.0`. |

All requests go to `POST /mcp`. `GET` and `DELETE` return 405.

## Usage with Claude Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "pokeapi": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Exact keys vary by client — consult your MCP client's docs for its HTTP transport config syntax.

## Development

```bash
npm run dev   # run with tsx (no build step)
npm run build # compile TypeScript
npm start     # run compiled output
```

## Data source

All data is fetched live from [pokeapi.co](https://pokeapi.co). No API key required.
