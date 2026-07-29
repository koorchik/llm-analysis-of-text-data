# SecureBERT sidecar

Serves [SecureBERT](https://huggingface.co/ehsanaghaei/SecureBERT) over an OpenAI-compatible
`/v1/embeddings` endpoint, so `EmbeddingsBackendHttp` can reach it with no model-specific code.

**Why this exists.** `EmbeddingsClient` has SDK backends for OpenAI, Ollama and Vertex AI, and none
of them serves a HuggingFace RoBERTa-family model. Without a serving path the encoder arm that
settles the published contradiction (`cheng2025ctinexus` recommends a security-domain encoder,
`yang2026ctithinker` reports a general one working better) could not run at all. Targeting the
OpenAI request shape rather than inventing one means a `sentence-transformers` server works here
too — swap the image, keep the backend.

## Run it

```bash
cd tools/securebert-sidecar
docker compose up -d          # first start downloads the model into ./data
docker compose logs -f        # wait for "Ready"
```

Smoke test — this is the check to run before blaming the pipeline:

```bash
curl -s http://localhost:8080/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"securebert","input":["APT28","Fancy Bear"]}' \
  | jq '{n: (.data|length), dims: (.data[0].embedding|length)}'
```

Expect `{"n": 2, "dims": 768}`. Two vectors for two inputs, and 768 because SecureBERT is
RoBERTa-base sized. A single vector back means the batch path is broken; anything other than 768
means the image is serving a different model than you think.

## Point a run at it

```bash
EMBEDDINGS_PROVIDER=http \
EMBEDDINGS_MODEL=securebert \
EMBEDDINGS_URL=http://localhost:8080 \
EMBEDDINGS_POOLING=mean \
CANDIDATE_GENERATOR=embedding \
CONDITION=e4-securebert \
FLOW=incremental npm start
```

`EMBEDDINGS_MODEL` is a label here — the sidecar serves whatever `--model-id` says — but it is what
the cache file, the price lookup and the runId are keyed on, so keep it stable and distinct from the
other encoders.

## Two things that belong in the write-up, not in a footnote

1. **Pooling is an experimental variable, not a deployment detail.** SecureBERT ships no
   sentence-transformers pooling configuration, so `--pooling` is a choice this project makes.
   `mean` (over last hidden states) is the convention; `cls` would take RoBERTa's `<s>` token, which
   was never trained as a sentence summary for this checkpoint. Whichever is used, set
   `EMBEDDINGS_POOLING` to match — that is the value the run card records, and a mismatch would make
   the card describe a configuration that did not run.

2. **SecureBERT was never contrastively trained for cosine similarity.** It is a masked-language
   model; BGE-M3 and `text-embedding-3-large` are retrieval encoders. If the domain-specific model
   underperforms the general ones, that difference — objective, not domain — is a candidate
   explanation and has to be stated alongside the numbers. Otherwise the result reads as
   "security-domain pretraining does not help retrieval", which the experiment does not show.

## Status

⚠️ **The compose file has not been run in this environment** (no Docker daemon available when it was
written). The image tag, the `--pooling` flag and the OpenAI-compatible route are from
`text-embeddings-inference`'s documented interface; treat the first `docker compose up` as the
verification step and fix the tag here if it has moved. `EmbeddingsBackendHttp` itself is unit
tested against the response shape.
