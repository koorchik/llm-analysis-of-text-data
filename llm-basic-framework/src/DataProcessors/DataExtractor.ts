import type { LlmClient } from '../LlmClient/LlmClient';
import {
  extractAndParseJson,
  normalizeRawData,
  UnifiedData,
} from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

type Preprocessor = (
  content: string
) => Promise<{ text: string; metadata: Record<string, string | number> }>;

interface Params {
  inputDir: string;
  outputDir: string;
  llmClient: LlmClient;
  preprocessor?: Preprocessor;
}

export class DataExtractor {
  public readonly inputDir: string;
  public readonly outputDir: string;

  #llmClient: LlmClient;
  #preprocessor: Preprocessor = (content: string) =>
    Promise.resolve({
      text: content,
      metadata: {},
    });

  constructor(params: Params) {
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;

    if (params.preprocessor) {
      this.#preprocessor = params.preprocessor;
    }
  }

  async run() {
    if (!existsSync(this.outputDir)) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    const files = await fs.readdir(this.inputDir);

    for (const file of files) {
      console.log(`IN FILE=${this.inputDir}/${file}`);
      const content = await fs.readFile(`${this.inputDir}/${file}`);
      const data = await this.#preprocessor(content.toString());

      const started = Date.now();
      const response = await this.#sendToLlm(data.text);
      const spent = (Date.now() - started) / 1000;

      await this.#saveResponse(
        file,
        JSON.stringify(
          {
            ...response,
            metadata: { ...data.metadata, llmProcessingTimeSeconds: spent },
          },
          undefined,
          2
        )
      );
      // break;
    }
  }

  async #sendToLlm(text: string): Promise<UnifiedData | {}> {
    const instructions = `### ROLE ###
You are a specialized AI model functioning as a high-precision data extraction engine. Your purpose is to parse unstructured text about cyber incidents and convert it into a structured JSON object according to the strict schema and rules provided.

### OBJECTIVE ###
Your sole objective is to identify, classify, and structure all relevant entities from the provided text into the specified JSON format. You must adhere meticulously to all definitions, rules, and constraints.

### STEP-BY-STEP WORKFLOW ###
1.  **Full Analysis**: First, read the entire input text to comprehend the complete context of the incident.
2.  **Entity Identification**: Scan the text and pinpoint all potential entities that match the categories defined in the schema.
3.  **Rule-Based Classification**: For each identified entity, apply the definitions and the "RULES ENGINE" to determine its precise \`category\` and \`role\`.
4.  **JSON Formatting**: Consolidate all validated entities into the final JSON structure, ensuring no duplicates and strict adherence to the output format.

### EXTRACTION SCHEMA ###
You MUST extract entities into a list called \`entities\`. Each entity is an object with three required keys: "name", "category", and "role".

**1. Category Definitions (MUST be one of the following):**
  * \`Organization\`: A specific company, corporation, or non-governmental group (e.g., "Microsoft", "CyberTrace", "Red Cross").
  * \`HackerGroup\`: A named threat actor, APT group, or cyber-criminal collective (e.g., "Sandworm", "IronNomad", "APT28").
  * \`Software\`: Specific malware, tools, vulnerabilities, or legitimate software involved (e.g., "Industroyer2", "Log4j", "Cisco IOS").
  * \`Country\`: A nation-state or country (e.g., "Ukraine", "USA", "China").
  * \`Individual\`: A specific, named person (e.g., "John Doe").
  * \`Domain\`: A fully qualified domain name (FQDN) used for C2, phishing, or other purposes (e.g., "control.ironnomad.net").
  * \`Sector\`: A broad industry or category of victims (e.g., "Energy Sector", "Ukrainian news websites", "Financial Institutions").
  * \`Government Body\`: A specific government agency or military branch (e.g., "FBI", "SBU", "Ministry of Defence of Ukraine").
  * \`Infrastructure\`: Large-scale foundational systems or networks (e.g., "Ukrainian power grid", "telecom networks").
  * \`Device\`: Specific types of hardware or network appliances (e.g., "Cisco ASA Firewall", "home routers", "PLCs").

**2. Role Definitions (MUST be one of the following):**
  * \`Target\`: The ultimate entity being victimized or attacked.
  * \`Attacker\`: The aggressor, or any software, domain, or infrastructure directly controlled by and used by the aggressor to facilitate an attack.
  * \`Neutral\`: A third-party observer, security researcher, reporting agency, or any entity not directly involved in the conflict.

### RULES ENGINE ###
Apply these rules in order. The logic here is absolute.

* **Rule 1: Role Assignment Logic**
  * An entity's role is determined by its function in the incident:
    * **Condition A: Assign "Attacker" Role** if the entity meets **any** of these criteria:
      * It is explicitly identified as the aggressor (e.g., a HackerGroup).
      * It is a resource directly controlled by the aggressor, such as:
        * **A.1: Malware/Tools:** Software used to perform the attack.
        * **A.2: C2 Infrastructure:** Domains or IPs used for command and control.
        * **A.3: Compromised Infrastructure:** Devices or servers that were taken over and then used to launch further attacks (e.g., botnets). This is the "Compromised Infrastructure Rule".
    * **Condition B: Assign "Target" Role** if the entity is the final recipient of the malicious activity and does not meet any criteria under Condition A.
    * **Condition C: Assign "Neutral" Role** if the entity is an observer, reporter, or researcher not involved in the conflict.

* **Rule 2: Implied Country Extraction**
  * **IF** you extract an entity with the category \`Government Body\`,
  * **AND** the name of that entity explicitly contains the name of a country (e.g., "Ministry of Defence of **Ukraine**", "**US** Department of State"),
  * **THEN** you MUST also generate a second, separate \`Country\` entity for that nation.
  * This new Country entity MUST be assigned the **same role** as the Government Body it was derived from.

* **Rule 3: Strict Adherence** (Previously Rule 2)
  * The values for \`category\` and \`role\` MUST be chosen exclusively from the definition lists provided above. Do not invent or modify values.

* **Rule 4: Deduplication** (Previously Rule 3)
  * The final \`entities\` list must not contain duplicates. An entity is a duplicate if its \`name\`, \`category\`, and \`role\` are all identical.

* **Rule 5: Negative Constraints (Exclusions)** (Previously Rule 4)
  * **DO NOT** extract the following:
    * The entity "CERT-UA". It is a reporting body to be ignored.
    * Generic, non-specific technologies like "the internet," "computers," or "networks" unless they refer to a specific, targeted infrastructure (e.g., "the Viasat satellite network").

### EXAMPLE OF EXECUTION ###

**Input Text:**
"The threat group IronNomad, believed to be operating out of China, is exploiting a vulnerability in 'SmartHome V2' home routers. According to a report by the US-based security firm CyberTrace, thousands of these devices have been compromised. The attacker uses the compromised routers, controlled via the C2 domain control.ironnomad.net, to launch DDoS attacks against various Ukrainian news websites. The incident was later analyzed by the Security Service of Ukraine (SBU)."

**Correct JSON Output:**
{
  "entities": [
    {
      "name": "IronNomad",
      "category": "HackerGroup",
      "role": "Attacker"
    },
    {
      "name": "China",
      "category": "Country",
      "role": "Attacker"
    },
    {
      "name": "SmartHome V2 home routers",
      "category": "Device",
      "role": "Attacker"
    },
    {
      "name": "CyberTrace",
      "category": "Organization",
      "role": "Neutral"
    },
    {
      "name": "USA",
      "category": "Country",
      "role": "Neutral"
    },
    {
      "name": "control.ironnomad.net",
      "category": "Domain",
      "role": "Attacker"
    },
    {
      "name": "Ukrainian news websites",
      "category": "Sector",
      "role": "Target"
    },
    {
      "name": "Security Service of Ukraine (SBU)",
      "category": "Government Body",
      "role": "Neutral"
    },
    {
      "name": "Ukraine",
      "category": "Country",
      "role": "Neutral"
    }
  ]
}

### FINAL OUTPUT FORMAT ###
Your final output MUST be a single, raw JSON object and nothing else. Do not wrap it in markdown code blocks (\`\`\`json). Do not add any conversational text, explanations, or apologies before or after the JSON object. If no entities are found, you MUST return an empty list within the JSON structure: \`{"entities": []}\`.

Apply these instructions to the text provided in the user's next message.`;

    console.time('LLM PROCESSING');
    const result = await this.#llmClient.send(instructions, text);
    console.timeEnd('LLM PROCESSING');
    console.time('EXTRACT_JSON');
    console.log({ result });
    // TODO: check if result contains JSON
    const rawData = extractAndParseJson(result);
    console.timeEnd('EXTRACT_JSON');

    if (!rawData) return {};

    console.time('NORMALIZE_DATA');
    const normalizedData = normalizeRawData(rawData);
    console.timeEnd('NORMALIZE_DATA');
    return normalizedData || {};
  }

  async #saveResponse(originalFile: string, text: string) {
    const rawResultFile = `${this.outputDir}/${originalFile}`;
    console.log(`OUT FILE=${rawResultFile}`);
    await fs.writeFile(rawResultFile, text);
  }
}
