import DocActions from "../components/DocActions";
import type { DocActionsProps } from "../components/DocActions";

const LORE_ARTICLE = "https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload";

export default function PlatformPage(props: DocActionsProps) {
  return (
    <div className="content">
      <section className="section" id="introduction">
        <div className="section-head">
          <h1>NeuroSim Docs</h1>
          <DocActions {...props} />
        </div>
        <p className="lead">
          NeuroSim is a fly-brain simulation where you buy NeuroFlies, release them into the world, and earn $NEURO when they collect food.
          It uses a real <em>Drosophila</em> fruit fly connectome (FlyWire) — real neurons and synapses driving autonomous behavior in a 3D world.
        </p>
        <div className="feature-grid">
          <article className="feature-card">
            <img className="feature-icon" src="/fly.svg" alt="" aria-hidden="true" />
            <div className="feature-title">Real Connectome</div>
            <p>FlyWire dataset: real neurons and connections from <em>Drosophila melanogaster</em>.</p>
          </article>
          <article className="feature-card">
            <img className="feature-icon" src="/fly.svg" alt="" aria-hidden="true" />
            <div className="feature-title">Autonomous Behavior</div>
            <p>Flies navigate, get hungry, seek food, rest, and explore — driven by the brain model.</p>
          </article>
          <article className="feature-card">
            <img className="feature-icon" src="/fly.svg" alt="" aria-hidden="true" />
            <div className="feature-title">Token Rewards</div>
            <p>Each food item collected rewards ~1,000 $NEURO tokens to the fly owner.</p>
          </article>
          <article className="feature-card">
            <img className="feature-icon" src="/fly.svg" alt="" aria-hidden="true" />
            <div className="feature-title">3D World</div>
            <p>Watch your NeuroFlies in a shared 3D simulation at world.neurosim.fun.</p>
          </article>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <h2>How It Works</h2>
        <p>Buy a NeuroFly, release it into the simulation, and earn rewards as it collects food.</p>
        <ol>
          <li>Buy a NeuroFly for 1,000,000 $NEURO tokens.</li>
          <li>Release it into the simulation (Enter World).</li>
          <li>The fly autonomously navigates — it gets hungry, seeks food, rests when tired, and explores.</li>
          <li>Each food item collected rewards approximately 1,000 $NEURO tokens.</li>
        </ol>
      </section>

      <section className="section" id="connectome">
        <h2>The Connectome</h2>
        <p>
          NeuroSim uses the <strong>FlyWire</strong> dataset — real neurons and synapses from the fruit fly <em>Drosophila melanogaster</em>.
          The connectome defines how sensory input (food, light) flows through the brain to drive motor output (flight, heading).
          Neurons are assigned roles for hunger, exploration, rest, and movement.
        </p>
        <p>
          A toy neural simulation steps the connectome forward in time, producing fly behavior without hand-coded logic.
        </p>
      </section>

      <section className="section" id="lore">
        <h2>Lore</h2>
        <p>
          The project is inspired by the article <a href={LORE_ARTICLE} target="_blank" rel="noopener noreferrer">&quot;The First Multi-Behavior Brain Upload&quot;</a> on The Innermost Loop.
          It describes the first full brain upload of a fruit fly — a multi-behavior model that can navigate, forage, and rest.
          NeuroSim takes that research and wraps it in a token-gated, on-chain game.
        </p>
      </section>

      <section className="section" id="pricing">
        <h2>Pricing</h2>
        <div className="callout">
          <p><strong>1 NeuroFly</strong> = 1,000,000 $NEURO tokens. Each food collected rewards approximately <strong>1,000 $NEURO</strong>.</p>
        </div>
      </section>
    </div>
  );
}
