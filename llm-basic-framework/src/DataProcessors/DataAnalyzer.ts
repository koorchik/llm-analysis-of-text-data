import fs from "fs/promises";
import { existsSync } from "fs";
import { UnifiedData } from "../utils/validationUtils";

import TSNE from "tsne-js";

interface Params {
  inputDir: string;
  outputDir: string;
}

export class DataAnalyzer {
  public readonly inputDir: string;
  public readonly outputDir: string;

  constructor(params: Params) {
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
  }

  async run() {
    if (!existsSync(this.outputDir)) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    const files = await fs.readdir(this.inputDir);
    const allData = [];
    for (const file of files) {
      console.log(`FILE=${file}`);
      const content = await fs.readFile(`${this.inputDir}/${file}`);
      const data = JSON.parse(content.toString()) as UnifiedData;
      allData.push(data);
    }
    await this.#analyzeData(allData);

    // await this.#saveResponse(file, JSON.stringify(response, undefined, 2));
  }

  async #analyzeData(data: UnifiedData[]): Promise<any | {}> {
    // const countriesStats = this.#countriesStats(data);
    this.#computeTsne(data);
    // console.log(countriesStats);
  }

  #countriesStats(data: UnifiedData[]) {
    const countriesStats: {
      Attacker: Record<string, number>;
      Target: Record<string, number>;
      Neutral: Record<string, number>;
    } = {
      Attacker: {},
      Target: {},
      Neutral: {},
    };

    for (const item of data) {
      if (!item.entities) continue;
      for (const entity of item.entities) {
        if (entity.category !== 'Country' || !entity.code) continue;
        countriesStats[entity.role][entity.code] =
          (countriesStats[entity.role][entity.code] || 0) + 1;
      }
    }

    return countriesStats;
  }

  async #computeTsne(records: UnifiedData[]) {
    const data = records.flatMap((item) =>
      (item.entities || []).filter(
        (e) => e.embedding && e.embedding.length > 0
      )
    );

    if (data.length === 0) {
      console.log("No entities with embeddings found, skipping t-SNE");
      return;
    }

    const vectors = data.map((d) => d.embedding!);

    const tsne = new TSNE({
      dim: 2,
      perplexity: 30,
      earlyExaggeration: 4.0,
      learningRate: 100,
      nIter: 500,
      metric: "euclidean",
    });

    // Initialize with your embedding vectors (dense format)
    tsne.init({
      data: vectors,
      type: "dense",
    });

    // Run the optimization
    tsne.run();

    const tsneResults = tsne.getOutputScaled(); // Array<[number, number]>

    const tsneData = data.map((d, i) => ({
      name: d.name,
      x: tsneResults[i][0],
      y: tsneResults[i][1],
    }));

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>t-SNE Visualization</title>
      <!-- Load Chart.js and DataLabels plugin from CDN -->
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels"></script>
    </head>
    <body>
      <canvas id="chartCanvas" width="800" height="600"></canvas>
    
      <script>
        // t-SNE data from Node, embedded as JSON
        const tsneData = ${JSON.stringify(tsneData)};
    
        // We'll register the DataLabels plugin so Chart.js can use it
        window.addEventListener('DOMContentLoaded', () => {
          Chart.register(ChatGPTChartHelpers.chartjsPluginDatalabels);
    
          // Or if the plugin is globally available, you can do:
          // Chart.register(ChartDataLabels);
    
          // Build the dataset
          const scatterData = {
            datasets: [
              {
                label: 't-SNE Visualization',
                data: tsneData, // each { x, y, name }
                backgroundColor: 'rgba(255, 99, 132, 0.8)',
              }
            ]
          };
    
          // Set up the config, enabling the datalabels plugin
          const config = {
            type: 'scatter',
            data: scatterData,
            options: {
              plugins: {
                datalabels: {
                  // The 'value' argument has { x, y, name }
                  formatter: (value) => value.name,
                  align: 'top',
                  anchor: 'end',
                  color: '#000',
                  font: {
                    size: 12,
                  }
                }
              },
              scales: {
                x: {
                  type: 'linear',
                  position: 'bottom',
                  title: {
                    display: true,
                    text: 't-SNE X'
                  }
                },
                y: {
                  type: 'linear',
                  title: {
                    display: true,
                    text: 't-SNE Y'
                  }
                }
              }
            }
          };
    
          // Create the chart
          const ctx = document.getElementById('chartCanvas').getContext('2d');
          new Chart(ctx, config);
        });
    
        // Workaround: "chartjs-plugin-datalabels" is loaded as a UMD script.
        // In some Chart.js versions, you might reference it like:
        //   Chart.register(ChartDataLabels);
        // For this snippet, we'll attach it to a global variable so we can register it.
        window.ChatGPTChartHelpers = {
          chartjsPluginDatalabels: this['chartjs-plugin-datalabels'] || {}
        };
      </script>
    </body>
    </html>
    `;

    // 6) Write the HTML to file
    await fs.writeFile(
      `${this.outputDir}/tsne-chart.html`,
      htmlContent,
      "utf-8"
    );
    console.log("t-SNE chart generated: tsne-chart.html");

    // console.log(tsneData);
  }

  // async #saveResponse(originalFile: string, content: string) {
  //   const rawResultFile = `${this.outputDir}/${originalFile}`;
  //   await fs.writeFile(rawResultFile, content);
  // }
}
