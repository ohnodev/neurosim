import './App.css'

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
]

function App() {
  return (
    <main className="paper">
      <header className="paper-header">
        <p className="eyebrow">Preprint Draft v0.1</p>
        <h1>
          Minimal Recurrence Modulation and Targeted P-E-N-A Activation Enable
          Precise Control of the Head-Direction Bump
        </h1>
        <p className="authors">NeuroSim Research Team</p>
      </header>

      <section className="block">
        <h2>Abstract</h2>
        <p>
          We present a full-connectome simulation study of heading dynamics in
          the fly central complex using public FlyWire-derived connectivity and a
          Rust-optimized dynamical engine. The model operates at 0.1 ms timestep
          resolution with calcium-state updates in physical time and explicit
          recurrent propagation. A single targeted structural intervention,
          tripling EPG-to-EPG recurrent weights, is sufficient to improve bump
          retention without rewiring upstream pathways. On top of this stable
          substrate, sparse stimulation of selected P-E-N-A neurons drives
          reproducible bump placement at defined clock positions, and
          two-to-three-neuron combinations provide robust transitions between
          attractor states. These findings support a minimal-control mechanism in
          which recurrence sets memory persistence while sparse P-E-N-A drive
          steers heading state. The manuscript includes executable simulation
          settings, stimulation protocols, and structured result tables to
          support direct replication and rapid iteration toward experimental
          predictions.
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
          network topology while exposing reproducible control handles.
        </p>
      </section>

      <section className="block">
        <h2>Results</h2>

        <h3>1. Simulation framework and minimal recurrence intervention</h3>
        <p>
          The simulation is implemented in Rust and integrated with a web-facing
          analysis UI. Dynamics are stepped at 0.1 ms resolution, and calcium
          decay is handled in millisecond units for interpretable physiological
          timing. We apply one targeted intervention: a 3x increase in EPG-EPG
          recurrence. No upstream structural edits are introduced.
        </p>

        <figure>
          <figcaption>Figure 1. Engine timeline and recurrence intervention.</figcaption>
          <svg viewBox="0 0 760 170" role="img" aria-label="timeline of simulation pipeline">
            <rect x="10" y="30" width="220" height="48" rx="8" className="svg-card" />
            <rect x="270" y="30" width="220" height="48" rx="8" className="svg-card" />
            <rect x="530" y="30" width="220" height="48" rx="8" className="svg-card" />
            <text x="120" y="59" textAnchor="middle">0.1 ms tick integration</text>
            <text x="380" y="59" textAnchor="middle">Calcium decay in ms domain</text>
            <text x="640" y="59" textAnchor="middle">EPG→EPG weight x3</text>
            <line x1="230" y1="54" x2="270" y2="54" className="svg-line" />
            <line x1="490" y1="54" x2="530" y2="54" className="svg-line" />
            <rect x="10" y="105" width="740" height="44" rx="8" className="svg-band" />
            <text x="380" y="132" textAnchor="middle">
              Full-connectome topology preserved outside targeted recurrence modulation
            </text>
          </svg>
        </figure>

        <h3>2. Single-neuron P-E-N-A response mapping</h3>
        <p>
          Individual 100 Hz stimulation tests reveal stable preferred bump
          positions for most left and right PEN_a units, with a minority showing
          drift or weak drive. This creates a practical control atlas for
          deterministic state setting.
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
          <figcaption>Figure 2. Example bump trajectory controls from sparse combinations.</figcaption>
          <svg viewBox="0 0 760 220" role="img" aria-label="example bump trajectory lines">
            <rect x="20" y="20" width="720" height="180" rx="12" className="svg-band" />
            <polyline
              points="40,175 90,145 140,120 190,115 240,80 290,82 340,86 390,62 440,58 490,78 540,70 590,52 640,48 700,50"
              className="traj-a"
            />
            <polyline
              points="40,140 90,136 140,142 190,132 240,124 290,110 340,108 390,94 440,100 490,88 540,93 590,80 640,76 700,71"
              className="traj-b"
            />
            <polyline
              points="40,94 90,98 140,90 190,98 240,110 290,123 340,119 390,132 440,127 490,134 540,129 590,141 640,145 700,139"
              className="traj-c"
            />
            <text x="56" y="40">11 PM target set</text>
            <text x="285" y="40">3 PM transfer</text>
            <text x="515" y="40">8 PM transfer</text>
          </svg>
        </figure>

        <h3>3. Multi-neuron transfer sets</h3>
        <p>
          We identify compact command sets that consistently transfer bump
          states between attractor positions while preserving ring integrity.
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
      </section>

      <section className="block">
        <h2>Discussion</h2>
        <p>
          The results support a two-part control principle: recurrence tuning
          sets stability and sparse P-E-N-A activation sets position. This
          decomposition is experimentally useful because it predicts that
          perturbing recurrent gain and perturbing sparse steering inputs should
          produce separable phenotypes in vivo. Current limitations include the
          absence of explicit synaptic noise and the need for broader protocol
          sweeps across inhibitory regimes.
        </p>
      </section>

      <section className="block">
        <h2>Resource Availability</h2>
        <ul>
          <li>Code: Rust simulation engine and analysis scripts in this repository.</li>
          <li>Data: FlyWire-based whole-brain connectivity resources used for model construction.</li>
          <li>Reproducibility: stimulation presets and control mappings documented in-app.</li>
        </ul>
      </section>

      <section className="block">
        <h2>Methods (Draft Skeleton)</h2>
        <ol>
          <li>Connectome extraction and neuron-group definitions (EPG, PEN_a, inhibitory rings).</li>
          <li>Simulation kernel: 0.1 ms timestep integration and calcium decay parameterization.</li>
          <li>Recurrence protocol: EPG-EPG weights scaled by 3x.</li>
          <li>Stimulation protocol: single-neuron and combinatorial PEN_a 100 Hz activation tests.</li>
          <li>Bump tracking: peak-angle extraction, drift quantification, and transfer success scoring.</li>
        </ol>
      </section>

      <section className="block">
        <h2>References</h2>
        <ol className="references">
          {references.map((ref) => (
            <li key={ref.id}>
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
    </main>
  )
}

export default App
