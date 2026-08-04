import type { GoldCluster, GoldEdge, GoldTable } from '../Evaluation/gold';

/**
 * A visual, human-checkable rendering of the built gold table: per category, the granularity
 * forests (finer clusters nested under coarser, per the `isa`/`part-of` edges), rename chains,
 * flat merged clusters, and the singleton tail — one self-contained HTML file, no dependencies,
 * themed for light and dark.
 *
 * The point is *review*, not analytics: a wrong merge reads as a stranger in an alias list, a
 * wrong rung as a child under the wrong parent — both easier to spot in a tree than in 3,400
 * TSV rows.
 */

export interface TreeNode {
  cluster: GoldCluster;
  /** The edge that put this node under its parent; undefined on roots. */
  edge?: GoldEdge;
  children: TreeNode[];
  /** True when the cluster already appeared under another parent (DAG) or on a broken cycle. */
  repeated?: boolean;
}

export interface CategoryView {
  category: string;
  /** Hierarchy forests: roots are the coarsest clusters. */
  trees: TreeNode[];
  /** renamed-to links, shown as chains rather than hierarchy. */
  renames: Array<{ from: GoldCluster; to: GoldCluster; edge: GoldEdge }>;
  /** Multi-member clusters that participate in no edge. */
  flatMerged: GoldCluster[];
  /** Single-member clusters that participate in no edge. */
  singletons: GoldCluster[];
}

export function buildCategoryViews(table: GoldTable): CategoryView[] {
  const byId = new Map(table.clusters.map((cluster) => [cluster.id, cluster]));
  const categories = [...new Set(table.clusters.map((cluster) => cluster.category))].sort();

  return categories.map((category) => {
    const clusters = table.clusters.filter((cluster) => cluster.category === category);
    const edges = (table.edges ?? []).filter((edge) => edge.category === category);

    const hierarchy = edges.filter((edge) => edge.kind !== 'renamed-to');
    const renames = edges
      .filter((edge) => edge.kind === 'renamed-to')
      .flatMap((edge) => {
        const from = byId.get(edge.fromClusterId ?? '');
        const to = byId.get(edge.toClusterId ?? '');
        return from && to ? [{ from, to, edge }] : [];
      });

    // children[parentId] = edges whose finer side sits under parentId.
    const childEdges = new Map<string, GoldEdge[]>();
    const hasParent = new Set<string>();
    for (const edge of hierarchy) {
      if (!edge.fromClusterId || !edge.toClusterId) continue;
      childEdges.set(edge.toClusterId, [...(childEdges.get(edge.toClusterId) ?? []), edge]);
      hasParent.add(edge.fromClusterId);
    }
    const inHierarchy = new Set<string>();
    for (const edge of hierarchy) {
      if (edge.fromClusterId) inHierarchy.add(edge.fromClusterId);
      if (edge.toClusterId) inHierarchy.add(edge.toClusterId);
    }

    const seen = new Set<string>();
    const build = (cluster: GoldCluster, viaEdge: GoldEdge | undefined, path: Set<string>): TreeNode => {
      const repeated = seen.has(cluster.id);
      seen.add(cluster.id);
      const children =
        repeated || path.has(cluster.id)
          ? [] // repeat appearances and cycle re-entries render as leaves
          : (childEdges.get(cluster.id) ?? [])
              .map((edge) => {
                const child = byId.get(edge.fromClusterId!);
                return child ? build(child, edge, new Set([...path, cluster.id])) : null;
              })
              .filter((node): node is TreeNode => node !== null);
      return { cluster, edge: viaEdge, children, ...(repeated ? { repeated } : {}) };
    };

    // Roots: hierarchy members with no coarser parent. A cycle has no root — sweep up any
    // hierarchy cluster never rendered and root it as a (marked) fallback.
    const trees = clusters
      .filter((cluster) => inHierarchy.has(cluster.id) && !hasParent.has(cluster.id))
      .map((cluster) => build(cluster, undefined, new Set()));
    for (const cluster of clusters) {
      if (inHierarchy.has(cluster.id) && !seen.has(cluster.id)) {
        trees.push(build(cluster, undefined, new Set()));
      }
    }

    const inRename = new Set(renames.flatMap((rename) => [rename.from.id, rename.to.id]));
    const uninvolved = clusters.filter((cluster) => !inHierarchy.has(cluster.id) && !inRename.has(cluster.id));

    return {
      category,
      trees,
      renames,
      flatMerged: uninvolved.filter((cluster) => cluster.members.length > 1),
      singletons: uninvolved.filter((cluster) => cluster.members.length === 1),
    };
  });
}

// --- HTML rendering -----------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const clusterHtml = (cluster: GoldCluster, edge?: GoldEdge, repeated?: boolean): string => {
  const [head, ...aliases] = cluster.members;
  const kind = edge ? `<span class="kind kind-${edge.kind}">${edge.kind}</span>` : '';
  const aliasChips = aliases.map((alias) => `<span class="alias">${escapeHtml(alias)}</span>`).join('');
  const meta = `<span class="meta">${cluster.id} · ${cluster.stratum}${cluster.sources ? ' · ' + cluster.sources.join('+') : ''}</span>`;
  const repeat = repeated ? '<span class="meta">↑ repeated</span>' : '';
  return `${kind}<span class="name">${escapeHtml(head)}</span>${aliasChips}${meta}${repeat}`;
};

const nodeHtml = (node: TreeNode): string => {
  const children = node.children.map((child) => nodeHtml(child)).join('');
  const body = clusterHtml(node.cluster, node.edge, node.repeated);
  return children
    ? `<li class="node" data-name="${escapeHtml(node.cluster.members.join(' ').toLowerCase())}">${body}<ul>${children}</ul></li>`
    : `<li class="node" data-name="${escapeHtml(node.cluster.members.join(' ').toLowerCase())}">${body}</li>`;
};

/** Render the whole registry view as one self-contained HTML document body. */
export function renderRegistryHtml(table: GoldTable, options: { title: string }): string {
  const views = buildCategoryViews(table);
  const totalMerged = table.clusters.filter((cluster) => cluster.members.length > 1).length;

  const sections = views
    .map((view) => {
      const trees = view.trees.length
        ? `<h3>Granularity forest</h3><ul class="tree">${view.trees.map((tree) => nodeHtml(tree)).join('')}</ul>`
        : '';
      const renames = view.renames.length
        ? `<h3>Renames</h3><ul class="tree">${view.renames
            .map(
              (rename) =>
                `<li class="node" data-name="${escapeHtml(
                  [...rename.from.members, ...rename.to.members].join(' ').toLowerCase()
                )}">${clusterHtml(rename.from)} <span class="kind kind-renamed-to">renamed-to</span> ${clusterHtml(rename.to)}</li>`
            )
            .join('')}</ul>`
        : '';
      const flat = view.flatMerged.length
        ? `<h3>Merged clusters (no hierarchy)</h3><ul class="tree">${view.flatMerged
            .map((cluster) => `<li class="node" data-name="${escapeHtml(cluster.members.join(' ').toLowerCase())}">${clusterHtml(cluster)}</li>`)
            .join('')}</ul>`
        : '';
      const singles = view.singletons.length
        ? `<details><summary>${view.singletons.length} singletons (gold mints)</summary><ul class="tree">${view.singletons
            .map((cluster) => `<li class="node" data-name="${escapeHtml(cluster.members.join(' ').toLowerCase())}">${clusterHtml(cluster)}</li>`)
            .join('')}</ul></details>`
        : '';
      return `<section><h2>${escapeHtml(view.category)} <span class="meta">${view.trees.length} trees · ${view.renames.length} renames · ${view.flatMerged.length} flat merges · ${view.singletons.length} singletons</span></h2>${trees}${renames}${flat}${singles}</section>`;
    })
    .join('\n');

  return `<title>${escapeHtml(options.title)}</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --surface-2: #f1f0ee;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --line: #d8d7d3;
    --kind-isa: #2a78d6; --kind-part-of: #eb6834; --kind-renamed-to: #1baf7a;
    font: 14px/1.5 system-ui, sans-serif; background: var(--surface-1); color: var(--text-primary);
    max-width: 1100px; margin: 0 auto; padding: 24px; display: block;
  }
  @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #242423;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --line: #3a3a38;
    --kind-isa: #3987e5; --kind-part-of: #d95926; --kind-renamed-to: #199e70;
  } }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #242423;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --line: #3a3a38;
    --kind-isa: #3987e5; --kind-part-of: #d95926; --kind-renamed-to: #199e70;
  }
  .viz-root h1 { font-size: 1.3em; margin: 0 0 4px; }
  .viz-root h2 { font-size: 1.1em; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .viz-root h3 { font-size: 0.95em; margin: 14px 0 6px; color: var(--text-secondary); }
  .summary, .meta { color: var(--text-secondary); font-size: 0.85em; }
  ul.tree { list-style: none; padding-left: 0; margin: 4px 0; }
  ul.tree ul { list-style: none; padding-left: 22px; border-left: 1px solid var(--line); margin: 2px 0 2px 7px; }
  .node { padding: 2px 0; }
  .name { font-weight: 600; }
  .alias { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 0 7px; margin-left: 6px; font-size: 0.85em; white-space: nowrap; }
  .kind { font-size: 0.75em; font-weight: 600; border-radius: 4px; padding: 0 5px; margin-right: 7px; color: var(--surface-1); white-space: nowrap; display: inline-block; }
  .kind-isa { background: var(--kind-isa); }
  .kind-part-of { background: var(--kind-part-of); }
  .kind-renamed-to { background: var(--kind-renamed-to); }
  .meta { margin-left: 8px; }
  .legend { margin: 10px 0 0; }
  #filter { width: 320px; padding: 6px 10px; margin: 14px 0 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-1); color: var(--text-primary); }
  details > summary { cursor: pointer; color: var(--text-secondary); margin: 6px 0; }
  .hidden { display: none; }
</style>
<div class="viz-root">
  <h1>${escapeHtml(options.title)}</h1>
  <p class="summary">${table.clusters.length} clusters (${totalMerged} merged) · ${(table.edges ?? []).length} edges · corpus ${escapeHtml(table.inputContentHash.slice(0, 12))}…</p>
  <p class="legend"><span class="kind kind-isa">isa</span>version/qualifier of the same thing (folds by default)
     <span class="kind kind-part-of" style="margin-left:14px">part-of</span>finer sits inside coarser (edge, not merge)
     <span class="kind kind-renamed-to" style="margin-left:14px">renamed-to</span>same referent, re-designated over time</p>
  <input id="filter" type="search" placeholder="filter by any member name…" autocomplete="off">
  ${sections}
</div>
<script>
  const filter = document.getElementById('filter');
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const node of document.querySelectorAll('.node')) {
      const match = query === '' || node.dataset.name.includes(query) ||
        [...node.querySelectorAll('.node')].some((child) => child.dataset.name.includes(query));
      node.classList.toggle('hidden', !match);
    }
    for (const details of document.querySelectorAll('details')) {
      if (query !== '') details.open = [...details.querySelectorAll('.node')].some((n) => !n.classList.contains('hidden'));
    }
  });
</script>
`;
}
