import './App.css'
import { useEffect, useState } from 'react'

type NeuronMapRow = {
  neuron: string
  protocol: string
  observedPeak: string
  note?: string
}

const leftPenA: NeuronMapRow[] = [
  { neuron: 'L1', protocol: '100 Hz', observedPeak: '11 PM' },
  { neuron: 'L2', protocol: '100 Hz', observedPeak: '11 PM' },
  { neuron: 'L3', protocol: '100 Hz', observedPeak: '3 PM', note: 'insufficient drive' },
  { neuron: 'L4', protocol: '100 Hz', observedPeak: '8 PM', note: 'slightly low drive' },
  { neuron: 'L5', protocol: '100 Hz', observedPeak: '3 PM' },
  { neuron: 'L6', protocol: '100 Hz', observedPeak: '11 PM' },
  { neuron: 'L7', protocol: '100 Hz', observedPeak: '3 PM', note: 'drifts toward 4 PM' },
  { neuron: 'L8', protocol: '100 Hz', observedPeak: '3 PM', note: 'drifts toward 2 PM' },
  { neuron: 'L9', protocol: '100 Hz', observedPeak: '8 PM', note: 'stable' },
  { neuron: 'L10', protocol: '100 Hz', observedPeak: '3 PM', note: 'leans toward 4 PM' },
]

const rightPenA: NeuronMapRow[] = [
  { neuron: 'R1', protocol: '100 Hz', observedPeak: '8 PM' },
  { neuron: 'R2', protocol: '100 Hz', observedPeak: '11 PM' },
  { neuron: 'R3', protocol: '100 Hz', observedPeak: '3 PM' },
  { neuron: 'R4', protocol: '100 Hz', observedPeak: '11 PM', note: 'insufficient drive' },
  { neuron: 'R5', protocol: '100 Hz', observedPeak: '3 PM', note: 'leans toward 2 PM' },
  { neuron: 'R6', protocol: '100 Hz', observedPeak: '3 PM', note: 'fast snap' },
  { neuron: 'R7', protocol: '100 Hz', observedPeak: '11 PM', note: 'strong response' },
  { neuron: 'R8', protocol: '100 Hz', observedPeak: 'No stable peak' },
  { neuron: 'R9', protocol: '100 Hz', observedPeak: '3 PM', note: 'leans toward 2 PM' },
  { neuron: 'R10', protocol: '100 Hz', observedPeak: '3 PM', note: 'leans toward 4 PM' },
]

const transferSets = [
  {
    target: '11 PM',
    command: 'L1:50, L2:50, L6:50',
    transition: 'Robust transfer toward 3 PM',
  },
  {
    target: '3 PM',
    command: 'L3:50, R6:70',
    transition: 'Robust transfer toward 8 PM',
  },
  {
    target: '8 PM',
    command: 'L4:50, L9:50, R1:60',
    transition: 'Stable setpoint with occasional late flip in L1-linked trials',
  },
]

const references = [
  {
    id: '1',
    text: 'Turner-Evans, D.B. et al. (2017). The neuroanatomical ultrastructure and function of a biological ring attractor.',
  },
  {
    id: '2',
    text: 'Turner-Evans, D.B. et al. (2020). Angular velocity integration in a fly heading circuit.',
  },
  {
    id: '3',
    text: 'Dorkenwald, S. et al. (2024). Neuronal wiring diagram of an adult Drosophila brain.',
  },
  {
    id: '4',
    text: 'Schlegel, P. et al. (2024). Whole-brain annotation and multi-connectome cell typing of Drosophila.',
  },
  {
    id: '5',
    text: 'Kim, S.Y. and Kim, A.J. (2026). Connectome analysis reveals brainwide visual processing in Drosophila.',
    href: 'https://www.biorxiv.org/content/10.64898/2026.02.02.700492v1.full',
  },
  {
    id: '6',
    text: 'Hulse, B.K. et al. (2021). A connectome of the Drosophila central complex reveals network motifs suitable for flexible navigation and context-dependent action selection. eLife 10:e66039.',
    href: 'https://elifesciences.org/articles/66039/figures',
  },
  {
    id: '7',
    text: 'Hulse, B.K. et al. Figure 16 asset (EPG projection reference image).',
    href: 'https://iiif.elifesciences.org/lax:66039%2Felife-66039-fig16-v4.tif/full/1500,/0/default.jpg',
  },
  {
    id: '8',
    text: 'FlyWire Brain Dataset (FAFB v783), Kaggle dataset by leonidblokhinrs.',
    href: 'https://www.kaggle.com/datasets/leonidblokhinrs/flywire-brain-dataset-fafb-v783/data?select=processed_labels.csv',
  },
  {
    id: '9',
    text: 'NeuroSim open-source repository (code and reproducibility assets).',
    href: 'https://github.com/ohnodev/neurosim',
  },
  {
    id: '10',
    text: 'EonSystems fly-brain repository (Brian2/Brian2CUDA/PyTorch reference implementation).',
    href: 'https://github.com/eonsystemspbc/fly-brain',
  },
  {
    id: '11',
    text: 'Shiu, P.K. et al. (2024). A Drosophila computational brain model reveals sensorimotor processing. Nature 634, 210-219.',
    href: 'https://www.nature.com/articles/s41586-024-07763-9',
  },
  {
    id: '12',
    text: 'Brian2 simulator repository (clock-driven simulator for spiking neural networks).',
    href: 'https://github.com/brian-team/brian2',
  },
]

function Cite({ ids }: { ids: string[] }) {
  return (
    <span className="citation-group">
      {ids.map((id, index) => (
        <span key={id}>
          <a className="citation" href={`#ref-${id}`} aria-label={`Jump to reference ${id}`}>
            [{id}]
          </a>
          {index < ids.length - 1 ? ', ' : ''}
        </span>
      ))}
    </span>
  )
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') {
      return 'light'
    }
    const storedTheme = window.localStorage.getItem('paper-theme')
    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('paper-theme', theme)
  }, [theme])

  const isDark = theme === 'dark'

  return (
    <main className="paper">
      <header className="paper-header">
        <p className="eyebrow">Preprint Draft v0.1</p>
        <h1>
          Minimal Recurrence Modulation and Targeted PEN_a Activation Enable
          Precise Control of the Head-Direction Bump
        </h1>
        <p className="authors">NeuroSim Research Team</p>
      </header>

      <section className="block">
        <h2>Abstract</h2>
        <p>
          We present a full-connectome simulation study of heading dynamics in
          the fly central complex using public FlyWire-derived connectivity and a
          Rust-optimized dynamical engine that ports Brian2-style LIF spiking
          dynamics into a production Rust/CUDA stack <Cite ids={['10', '12']} />. The model runs at
          0.1 ms timestep resolution with explicit recurrent propagation; calcium
          heatmaps are used only for activity readout and visualization, not as
          the core state dynamics. A single targeted structural intervention,
          tripling EPG-to-EPG recurrent weights, is sufficient to stabilize bump
          retention without rewiring upstream pathways. On this minimal substrate,
          sparse PEN_a stimulation provides controllable steering: a compact set
          of eight unique neurons is sufficient to reproducibly establish three
          discrete, stable heading setpoints (11 PM, 3 PM, 8 PM), spanning about
          120 degrees of angular separation across transfer protocols. We further
          observe that 1-2 neuron substitutions and stimulation-rate tuning
          (50-100 Hz) enable intermediate angle biasing between canonical
          setpoints. These results support a minimal-control principle in which
          recurrence sets memory persistence while sparse PEN_a drive sets and
          steers heading state, with executable protocols and structured result
          tables for direct replication.
        </p>
      </section>

      <section className="block">
        <h2>Introduction</h2>
        <p>
          Head-direction dynamics in Drosophila emerge from a densely recurrent
          ring-like architecture spanning EPG, PEN, and downstream inhibitory
          populations. Most published models achieve stability and steering via
          multiple parameter interventions. Here we evaluate a stricter
          hypothesis: can biologically grounded timing and one minimal recurrence
          change yield both stable memory and precision control? We address this
          question in a full-connectome simulation stack that preserves measured
          network topology while exposing reproducible control handles. As noted
          in <Cite ids={['6']} />, "PEN_a and PEN_b neurons are indeed strikingly different in
          their synaptic conn", which motivates the explicit separation of
          PEN_a-targeted control from PEN_b circuitry in this draft.
        </p>
      </section>

      <section className="block">
        <h2>Results</h2>

        <h3>1. Simulation framework and minimal recurrence intervention</h3>
        <p>
          The simulation is implemented in Rust and integrated with a web-facing
          analysis UI. Dynamics are stepped at 0.1 ms resolution with an
          explicit LIF spiking update path (Brian2-style model semantics) rather
          than calcium-state integration <Cite ids={['10', '12']} />. Calcium-style heatmapping is
          used for readout visualization only. The runtime constants follow the
          current Rust implementation: V_rest = -52 mV, V_reset = -52 mV,
          V_thresh = -45 mV, tau_mem = 20 ms, tau_syn = 5 ms, refractory = 2.2
          ms, and default W_syn = 0.339. The EPG recurrence gain is configured
          once when a simulation instance is created/loaded
          (NEUROSIM_EPG_RECURRENCE_BOOST or per-create override) and then held
          fixed for that run; it is not dynamically retuned during stepping.
          Reported experiments use a targeted EPG-to-EPG recurrence increase
          (3x condition) with no additional upstream structural edits.
        </p>

        <figure>
          <figcaption>Figure 1. Rust simulation flow and fixed recurrence configuration.</figcaption>
          <svg viewBox="0 0 760 210" role="img" aria-label="rust simulation load and run flow">
            <rect x="16" y="26" width="170" height="58" rx="10" className="svg-card" />
            <rect x="204" y="26" width="170" height="58" rx="10" className="svg-card" />
            <rect x="392" y="26" width="170" height="58" rx="10" className="svg-card" />
            <rect x="580" y="26" width="170" height="58" rx="10" className="svg-card" />

            <text x="101" y="50" textAnchor="middle" className="svg-title">Load connectome</text>
            <text x="101" y="68" textAnchor="middle" className="svg-sub">startup: single load</text>

            <text x="289" y="50" textAnchor="middle" className="svg-title">Cache template</text>
            <text x="289" y="68" textAnchor="middle" className="svg-sub">shared in memory</text>

            <text x="477" y="50" textAnchor="middle" className="svg-title">Create sim</text>
            <text x="477" y="68" textAnchor="middle" className="svg-sub">fixed EPG gain (3x run)</text>

            <text x="665" y="50" textAnchor="middle" className="svg-title">Step loop</text>
            <text x="665" y="68" textAnchor="middle" className="svg-sub">0.1 ms LIF updates</text>

            <line x1="186" y1="55" x2="204" y2="55" className="svg-line" />
            <line x1="374" y1="55" x2="392" y2="55" className="svg-line" />
            <line x1="562" y1="55" x2="580" y2="55" className="svg-line" />

            <rect x="16" y="108" width="734" height="78" rx="10" className="svg-band" />
            <text x="383" y="134" textAnchor="middle" className="svg-title">
              Runtime rule (code-accurate): no dynamic rewiring during stepping
            </text>
            <text x="383" y="154" textAnchor="middle" className="svg-sub">
              Full graph stays in memory; recurrence gain remains fixed per created simulation instance
            </text>
            <text x="383" y="172" textAnchor="middle" className="svg-sub">
              Reported condition uses targeted EPG-to-EPG recurrence boost with all other topology preserved
            </text>
          </svg>
        </figure>

        <h3>2. Single-neuron PEN_a response mapping</h3>
        <p>
          Individual 100 Hz stimulation tests reveal stable preferred bump
          positions for most left and right PEN_a units, with a minority showing
          drift or weak drive. This creates a practical control atlas for
          deterministic state setting. Across these tests, PEN_b was not the main
          driver of bump placement and was not directly stimulated in the control
          protocols reported here.
        </p>
        <p>
          A notable secondary observation is within-class PEN_a co-activation:
          stimulating a single PEN_a unit can intermittently recruit additional
          PEN_a neurons. In particular, L1 stimulation occasionally co-activated
          R1 and, in some trials, increased activity in L8-L10. This suggests
          that sparse steering commands propagate through structured recurrent
          pathways inside the PEN_a/EPG control subnetwork rather than acting as
          perfectly isolated channels.
        </p>

        <div className="table-grid">
          <article>
            <h4>Left PEN_a stimulation map</h4>
            <table>
              <thead>
                <tr>
                  <th>Neuron</th>
                  <th>Protocol</th>
                  <th>Observed Peak</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {leftPenA.map((row) => (
                  <tr key={row.neuron}>
                    <td>{row.neuron}</td>
                    <td>{row.protocol}</td>
                    <td>{row.observedPeak}</td>
                    <td>{row.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <article>
            <h4>Right PEN_a stimulation map</h4>
            <table>
              <thead>
                <tr>
                  <th>Neuron</th>
                  <th>Protocol</th>
                  <th>Observed Peak</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rightPenA.map((row) => (
                  <tr key={row.neuron}>
                    <td>{row.neuron}</td>
                    <td>{row.protocol}</td>
                    <td>{row.observedPeak}</td>
                    <td>{row.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        </div>

        <figure>
          <figcaption>
            Figure 2. PEN_a command schedule for three setpoints (visualized on a 0-50 Hz axis; all non-target channels hard-zeroed at phase switches).
          </figcaption>
          <svg viewBox="0 0 760 280" role="img" aria-label="eight PEN_a stimulation lines with zeroed handoff">
            <rect x="18" y="18" width="724" height="244" rx="12" className="svg-band" />

            <line x1="70" y1="44" x2="70" y2="196" className="svg-axis" />
            <line x1="70" y1="196" x2="650" y2="196" className="svg-axis" />

            <line x1="70" y1="44" x2="650" y2="44" className="svg-grid" />
            <line x1="70" y1="74" x2="650" y2="74" className="svg-grid" />
            <line x1="70" y1="104" x2="650" y2="104" className="svg-grid" />
            <line x1="70" y1="134" x2="650" y2="134" className="svg-grid" />
            <line x1="70" y1="164" x2="650" y2="164" className="svg-grid" />
            <line x1="70" y1="196" x2="650" y2="196" className="svg-grid" />

            <text x="58" y="199" textAnchor="end" className="svg-sub">0</text>
            <text x="58" y="167" textAnchor="end" className="svg-sub">10</text>
            <text x="58" y="137" textAnchor="end" className="svg-sub">20</text>
            <text x="58" y="107" textAnchor="end" className="svg-sub">30</text>
            <text x="58" y="77" textAnchor="end" className="svg-sub">40</text>
            <text x="58" y="47" textAnchor="end" className="svg-sub">50</text>
            <text x="34" y="118" textAnchor="middle" transform="rotate(-90 34 118)" className="svg-sub">Hz</text>

            <line x1="250" y1="44" x2="250" y2="196" className="svg-separator" />
            <line x1="450" y1="44" x2="450" y2="196" className="svg-separator" />

            <text x="160" y="32" textAnchor="middle" className="svg-title">11 PM command</text>
            <text x="350" y="32" textAnchor="middle" className="svg-title">3 PM command</text>
            <text x="550" y="32" textAnchor="middle" className="svg-title">8 PM command</text>

            <polyline points="70,44 250,44 250,196 650,196" className="stim-line" style={{ stroke: '#4f8dff' }} />
            <polyline points="70,44 250,44 250,196 650,196" className="stim-line" style={{ stroke: '#3ddc97' }} />
            <polyline points="70,44 250,44 250,196 650,196" className="stim-line" style={{ stroke: '#f6c445' }} />

            <polyline points="70,196 250,196 250,44 450,44 450,196 650,196" className="stim-line" style={{ stroke: '#e879f9' }} />
            <polyline points="70,196 250,196 250,44 450,44 450,196 650,196" className="stim-line" style={{ stroke: '#fb7185' }} />

            <polyline points="70,196 450,196 450,44 650,44" className="stim-line" style={{ stroke: '#22d3ee' }} />
            <polyline points="70,196 450,196 450,44 650,44" className="stim-line" style={{ stroke: '#a3e635' }} />
            <polyline points="70,196 450,196 450,44 650,44" className="stim-line" style={{ stroke: '#f97316' }} />

            <text x="665" y="52" className="svg-sub">L1</text>
            <text x="665" y="68" className="svg-sub">L2</text>
            <text x="665" y="84" className="svg-sub">L6</text>
            <text x="665" y="100" className="svg-sub">L3</text>
            <text x="665" y="116" className="svg-sub">R6</text>
            <text x="665" y="132" className="svg-sub">L4</text>
            <text x="665" y="148" className="svg-sub">L9</text>
            <text x="665" y="164" className="svg-sub">R1</text>

            <text x="160" y="214" textAnchor="middle" className="svg-sub">L1/L2/L6 = 50 Hz</text>
            <text x="350" y="214" textAnchor="middle" className="svg-sub">L3/R6 = 50 Hz</text>
            <text x="550" y="214" textAnchor="middle" className="svg-sub">L4/L9/R1 = 50 Hz</text>
            <text x="360" y="236" textAnchor="middle" className="svg-sub">
              At each switch: previous command set {'->'} 0 Hz, new target set {'->'} 50 Hz
            </text>
          </svg>
        </figure>

        <h3>3. Multi-neuron transfer sets</h3>
        <p>
          We identify compact command sets that consistently transfer bump
          states between attractor positions while preserving ring integrity.
          Three stable setpoints (11 PM, 3 PM, 8 PM) are produced using eight
          unique PEN_a neurons in total (L1, L2, L6, L3, R6, L4, L9, R1),
          corresponding to approximately 120 degrees of controllable heading
          rotation. Rate tuning and small substitutions then bias trajectories
          toward intermediate positions (for example, 2 PM or 4 PM-leaning
          states).
        </p>
        <ul>
          {transferSets.map((set) => (
            <li key={set.target}>
              <strong>{set.target} target:</strong> {set.command} {'->'} {set.transition}
            </li>
          ))}
        </ul>

        <h3>4. Inhibitory regulation and failure modes</h3>
        <p>
          Ring-neuron inhibition reliably suppresses bump persistence in
          over-driven protocols, while low-drive PEN_a subsets can fail to cross
          transfer thresholds. Together these effects define practical control
          boundaries for closed-loop experiments.
        </p>

        <h3>5. Runtime performance and optimization strategy</h3>
        <p>
          The Rust engine is optimized for real-time parallel execution with a
          CUDA path and a spike-driven active-edge update policy. Instead of
          scanning all synapses each step, recurrent propagation computes only
          edges from neurons that actually spiked in that tick, reducing
          per-step work from dense edge traversal to active-edge traversal. On
          GPU, we compact active spikes, scatter only their outgoing CSR edges,
          and execute delay, conductance, and LIF kernels on device in a single
          step pipeline. In internal parity benchmarks against the EonSystems
          fly-brain reference, this implementation achieved approximately 2.0x
          end-to-end and approximately 2.6x compute-path speedup under matched
          dt and run settings.
        </p>
      </section>

      <section className="block">
        <h2>Discussion</h2>
        <p>
          The results support a two-part control principle: recurrence tuning
          sets stability and sparse PEN_a activation sets position. This
          decomposition is experimentally useful because it predicts that
          perturbing recurrent gain and perturbing sparse steering inputs should
          produce separable phenotypes in vivo. Current limitations include the
          absence of explicit synaptic noise and the need for broader protocol
          sweeps across inhibitory regimes.
        </p>
        <p>
          The observed PEN_a-to-PEN_a co-activation (for example, intermittent
          L1-to-R1 recruitment with L8-L10 spillover) further indicates that
          directional control is mediated by coupled microcircuits, not purely
          one-neuron one-angle mappings. This motivates follow-up work to
          separate direct vs multi-hop recruitment paths and quantify how these
          interactions affect command robustness.
        </p>
        <p>
          A key next research direction is transition latency optimization. The
          current command-handoff protocol shifts the bump reliably, but faster
          switching under abrupt input changes remains an open control problem.
          Future work can test overlap windows, pulse-shaped stimulation, and
          adaptive Hz ramps to reduce settle time while preserving stability.
        </p>
      </section>

      <section className="block">
        <h2>Data and Code Availability</h2>
        <ul>
          <li>Primary connectome source data: FlyWire Brain Dataset (FAFB v783) from Kaggle <Cite ids={['8']} />.</li>
          <li>Code and reproducibility assets for this project: NeuroSim repository <Cite ids={['9']} />.</li>
          <li>Reference Brian2 model used for cross-checking LIF behavior: EonSystems fly-brain <Cite ids={['10']} />.</li>
          <li>Core simulator lineage and semantics: Brian2 spiking simulator repository <Cite ids={['12']} />.</li>
        </ul>
      </section>

      <section className="block">
        <h2>Methods (Draft Skeleton)</h2>
        <ol>
          <li>Connectome extraction and neuron-group definitions (EPG, PEN_a, inhibitory rings).</li>
          <li>Simulation kernel: 0.1 ms timestep Brian2-style LIF spiking integration (Rust port).</li>
          <li>Recurrence protocol: EPG recurrence gain set at sim creation and held constant during runtime (3x condition in reported runs).</li>
          <li>Stimulation protocol: single-neuron and combinatorial PEN_a 100 Hz activation tests.</li>
          <li>PEN_b handling: PEN_b units tracked for observability only and excluded from bump-driving stimulation.</li>
          <li>Bump tracking: peak-angle extraction, drift quantification, and transfer success scoring.</li>
        </ol>
        <h3>PEN_a mapping and directional control protocol</h3>
        <p>
          We first ran coarse control tests by turning all left PEN_a neurons on
          at 50 Hz, then all right PEN_a neurons on at 50 Hz. Both conditions
          could form a bump, but trajectories were unstable and often chaotic;
          side-wide stimulation was not granular enough for coherent directional
          control, and in some runs the bump settled into a difficult-to-move
          basin. We therefore moved to single-neuron mapping.
        </p>
        <p>
          Before single-neuron mapping, we calibrated the operating regime in the
          same style as the EonSystems reference <Cite ids={['10']} />, using the same 8 sugar
          GRNs and MN9 response readout. Relative to an approximately 90%
          reference regime at 100 Hz sugar stimulation, our matched Rust run
          reached approximately 76% in this calibration stage. We then fixed
          EPG-to-EPG recurrence gain at 3x for reported experiments (with 2x and
          4x explored as nearby settings) to support more persistent bump
          retention.
        </p>
        <p>
          We stimulated each individual PEN_a neuron at 100 Hz and recorded its
          dominant bump-location affinity. Neurons with shared affinity were then
          combined into minimal command sets, and we searched for the lowest
          stable Hz and smallest neuron subset that maintained a consistent bump
          at each target direction. For directional switching, prior stimulation
          channels were zeroed and the new command set was applied, producing
          reproducible and relatively fast heading-state transitions.
        </p>
        <h3>EPG-to-circle mapping protocol</h3>
        <p>
          EPG angular mapping is implemented to match the EPG-to-PB geometry shown
          in <Cite ids={['6']} /> and the Figure 16 visual reference in <Cite ids={['7']} />. We load
          <code>classification.csv</code> from <code>data/raw</code>, select rows
          tagged as EPG/PEN classes, and preserve hemisphere labels. As a concrete
          record from the source table, mappings include entries in the same raw
          format as <code>PEN_a(PEN1),DM2_CX_v,left</code>. We then assign each
          EPG neuron to its circular bin by ordering PB glomerulus identity from
          left-to-right and right-to-left according to the Figure 16 scheme, and
          convert bins to circle angles with fixed spacing so that each EPG slot
          remains deterministic across simulation runs.
        </p>
        <ol>
          <li>Read <code>data/raw/classification.csv</code> and parse neuron class, neuropil tag, and hemisphere.</li>
          <li>Filter to the EPG set used by the simulator while retaining PEN_a and PEN_b labels for connectivity context.</li>
          <li>Map PB glomerulus tags to ordered angular bins following the Figure 16 EPG layout.</li>
          <li>Project each EPG to a circle coordinate using fixed step angles and store this as the canonical lookup table.</li>
          <li>Keep this lookup unchanged during stimulation experiments so bump movement reflects circuit dynamics, not remapping.</li>
        </ol>
        <h3>Calibration against fly-brain and Nature protocol</h3>
        <p>
          To maintain consistency with the EonSystems modeling workflow <Cite ids={['10']} /> and
          the whole-brain LIF framing in Shiu et al. <Cite ids={['11']} />, we tune the Rust
          simulation at 0.1 ms timestep using sugar GRN stimulation sweeps,
          including the 100 Hz calibration point. The target operating regime is
          coherent MN9 recruitment near the high-response zone used in the
          reference protocol (approximately 90% operating region at 100 Hz), and
          we validate relative circuit behavior across matched stimulation
          schedules after calibration.
        </p>
      </section>

      <section className="block">
        <h2>References</h2>
        <ol className="references">
          {references.map((ref) => (
            <li key={ref.id} id={`ref-${ref.id}`}>
              {ref.href ? (
                <a href={ref.href} target="_blank" rel="noreferrer">
                  {ref.text}
                </a>
              ) : (
                ref.text
              )}
            </li>
          ))}
        </ol>
      </section>
      <button
        type="button"
        className="theme-toggle"
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      >
        {isDark ? '☀' : '☾'}
      </button>
    </main>
  )
}

export default App
