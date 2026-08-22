/**
 * Registry → SKOS / ISO 25964 (Turtle) exporter.
 *
 * The registry's v6 model maps onto the W3C SKOS vocabulary term for term (ontology alignment,
 * documented in the dissertation's methodology chapter):
 *
 *   concept scheme (category)  → skos:ConceptScheme (edges are same-scheme by construction, so
 *                                schemes are the graph-isolation boundary)
 *   concept                    → skos:Concept + skos:inScheme
 *   concept key                → skos:prefLabel
 *   label surfaces             → skos:altLabel
 *   definition                 → skos:definition
 *   broader edge               → skos:broader, typed per ISO 25964 via iso-thes:
 *                                broaderGeneric (BTG, is-a) · broaderPartitive (BTP, part–whole) ·
 *                                broaderInstantial (BTI, named instance/version)
 *   hierarchy roots            → skos:hasTopConcept / skos:topConceptOf
 *   rename edge                → skein:renamedTo (no SKOS-core equivalent: a rename is history,
 *                                not a thesaurus relation)
 *
 * Typed edges emit the iso-thes subproperty (each is rdfs:subPropertyOf skos:broader in the
 * iso-thes ontology) PLUS a materialized plain skos:broader triple, so consumers without
 * reasoning still see the hierarchy. Untyped edges emit only skos:broader.
 *
 * One thing SKOS core cannot say rides as an RDF 1.2 (RDF-star) annotation `{| ... |}` under the
 * custom `skein:` namespace: `skein:similarityScore` — the cosine similarity of the endpoint-name
 * embeddings, frozen at edge-creation time. A weight on a triple has no place in classic RDF.
 *
 * Output is deterministic (sorted schemes, concepts and edges; no timestamps), so two exports of
 * the same registry are byte-identical.
 */
import type { RegistryDataV6, BroaderType } from '../ConceptRegistry/ConceptRegistry';

export interface SkosExportOptions {
  /** Base IRI; concept and scheme IRIs are minted under it. */
  base?: string;
  /** Restrict the export to one scheme/category (case-insensitive). */
  category?: string;
}

const DEFAULT_BASE = 'urn:skein:';

const ISOTHES_PROPERTY: Record<BroaderType, string> = {
  broaderGeneric: 'isothes:broaderGeneric',
  broaderPartitive: 'isothes:broaderPartitive',
  broaderInstantial: 'isothes:broaderInstantial',
};

/** Percent-encode a name into an IRI-safe local segment (space → %20, etc.). */
const segment = (value: string): string => encodeURIComponent(value);

/** Escape a Turtle string literal. */
const literal = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function registryToTurtle(
  registry: RegistryDataV6,
  options: SkosExportOptions = {}
): string {
  const base = options.base ?? DEFAULT_BASE;
  const schemes = Object.keys(registry.conceptSchemes ?? {})
    .filter((name) => !options.category || name.toLowerCase() === options.category.toLowerCase())
    .sort(compareStrings);

  const schemeIri = (category: string) => `<${base}scheme:${segment(category)}>`;
  const conceptIri = (category: string, canonical: string) =>
    `<${base}${segment(category)}:${segment(canonical)}>`;

  const lines: string[] = [
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix isothes: <http://purl.org/iso25964/skos-thes#> .',
    '@prefix skein: <urn:skein:vocab:> .',
    '',
  ];

  for (const category of schemes) {
    const records = registry.conceptSchemes![category];
    const edges = (registry.broaderEdges?.[category] ?? [])
      .slice()
      .sort((a, b) => compareStrings(a.narrower, b.narrower) || compareStrings(a.broader, b.broader));
    const renames = (registry.renameEdges?.[category] ?? [])
      .slice()
      .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));

    const hasBroader = new Set(edges.map((edge) => edge.narrower));
    const inHierarchy = new Set(edges.flatMap((edge) => [edge.narrower, edge.broader]));
    // Top concepts: hierarchy participants with no broader concept of their own. Isolated
    // concepts are left unmarked — a flat scheme has no meaningful "top".
    const tops = [...inHierarchy].filter((name) => !hasBroader.has(name)).sort(compareStrings);

    lines.push(`${schemeIri(category)} a skos:ConceptScheme ;`);
    lines.push(`  skos:prefLabel ${literal(category)}${tops.length ? ' ;' : ' .'}`);
    tops.forEach((top, index) => {
      lines.push(
        `  skos:hasTopConcept ${conceptIri(category, top)}${index < tops.length - 1 ? ' ;' : ' .'}`
      );
    });
    lines.push('');

    for (const canonical of Object.keys(records).sort(compareStrings)) {
      const record = records[canonical];
      const surfaces = (record.labels ?? []).map((label) => label.surface);
      const altLabels = [...new Set(surfaces)]
        .filter((surface) => surface.toLowerCase() !== canonical.toLowerCase())
        .sort(compareStrings);

      lines.push(`${conceptIri(category, canonical)} a skos:Concept ;`);
      lines.push(`  skos:inScheme ${schemeIri(category)} ;`);
      const parts: string[] = [`  skos:prefLabel ${literal(canonical)}`];
      if (altLabels.length > 0) {
        parts.push(`  skos:altLabel ${altLabels.map(literal).join(', ')}`);
      }
      if (record.definition) {
        parts.push(`  skos:definition ${literal(record.definition)}`);
      }
      if (tops.includes(canonical)) {
        parts.push(`  skos:topConceptOf ${schemeIri(category)}`);
      }
      lines.push(parts.join(' ;\n') + ' .');
      lines.push('');
    }

    for (const edge of edges) {
      if (!records[edge.narrower] || !records[edge.broader]) continue;
      const narrower = conceptIri(category, edge.narrower);
      const broader = conceptIri(category, edge.broader);
      const annotation =
        typeof edge.similarityScore === 'number'
          ? ` {| skein:similarityScore ${edge.similarityScore} |}`
          : '';
      if (edge.type) {
        // The annotation rides the typed triple; the plain skos:broader is the materialized
        // inference for consumers without an iso-thes-aware reasoner.
        lines.push(`${narrower} ${ISOTHES_PROPERTY[edge.type]} ${broader}${annotation} .`);
        lines.push(`${narrower} skos:broader ${broader} .`);
      } else {
        lines.push(`${narrower} skos:broader ${broader}${annotation} .`);
      }
    }
    if (edges.length > 0) lines.push('');

    for (const rename of renames) {
      lines.push(
        `${conceptIri(category, rename.from)} skein:renamedTo ${conceptIri(category, rename.to)} .`
      );
    }
    if (renames.length > 0) lines.push('');
  }

  return lines.join('\n');
}
