import type { Relationship } from '@sondadata/schema';

/**
 * Rutas indirectas (§3.4): sobre el grafo de relaciones encontradas, caminos
 * de hasta `maxHops` saltos entre tablas SIN relación directa. El costo de un
 * camino es -log(score) acumulado, es decir, el score del camino es el
 * producto de los scores de sus tramos.
 */

export interface IndirectRoute {
  fromSourceId: string;
  toSourceId: string;
  /** Ids de las relaciones que componen el camino, en orden. */
  path: string[];
  /** Ids de las tablas intermedias. */
  via: string[];
  /** Producto de los scores de los tramos. */
  score: number;
}

export function findIndirectRoutes(relationships: Relationship[], maxHops = 3): IndirectRoute[] {
  const usable = relationships.filter((r) => r.userDecision !== 'rejected' && r.confidence !== 'low');
  const adj = new Map<string, { to: string; rel: Relationship }[]>();
  const direct = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const r of usable) {
    direct.add(pairKey(r.leftSourceId, r.rightSourceId));
    for (const [from, to] of [
      [r.leftSourceId, r.rightSourceId],
      [r.rightSourceId, r.leftSourceId],
    ] as const) {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, rel: r });
    }
  }

  const best = new Map<string, IndirectRoute>();
  for (const start of adj.keys()) {
    // BFS acotado con score acumulado
    const queue: { node: string; path: Relationship[]; visited: Set<string> }[] = [
      { node: start, path: [], visited: new Set([start]) },
    ];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.path.length >= maxHops) continue;
      for (const edge of adj.get(cur.node) ?? []) {
        if (cur.visited.has(edge.to)) continue;
        const path = [...cur.path, edge.rel];
        if (path.length >= 2 && !direct.has(pairKey(start, edge.to))) {
          const score = path.reduce((s, r) => s * r.score, 1);
          const key = pairKey(start, edge.to);
          const existing = best.get(key);
          if (!existing || score > existing.score) {
            best.set(key, {
              fromSourceId: start,
              toSourceId: edge.to,
              path: path.map((r) => r.id),
              via: path.slice(0, -1).map((r) => (r.leftSourceId === cur.node || r.rightSourceId === cur.node ? edge.to : '')),
              score,
            });
            // via correcta: nodos intermedios del camino
            const nodes: string[] = [start];
            for (const r of path) {
              const last = nodes[nodes.length - 1]!;
              nodes.push(r.leftSourceId === last ? r.rightSourceId : r.leftSourceId);
            }
            best.get(key)!.via = nodes.slice(1, -1);
          }
        }
        queue.push({ node: edge.to, path, visited: new Set([...cur.visited, edge.to]) });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
