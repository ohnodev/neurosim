import { OnchainProviders } from './components/OnchainProviders';
import { BrainPlot } from './components/BrainPlot';
import { ClaimFlySection } from './components/ClaimFlySection';
import { ConnectButton } from './components/ConnectButton';
import './App.css';

const LORE_ARTICLE = 'https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload';

function App() {
  return (
    <OnchainProviders>
      <div className="app">
        <div className="bg" aria-hidden />
        <header className="header">
          <span className="header__ticker">$NEURO</span>
          <ConnectButton />
        </header>

        <section className="hero">
          <div className="hero__brain">
            <BrainPlot />
          </div>
          <h1 className="hero__title">NeuroSim</h1>
          <p className="hero__tagline">Claim your digital fly. One brain, infinite simulations.</p>
        </section>

        <main className="main">
          <section className="section section--intro">
            <p className="section__text">
              Token launched on <strong>The Cabal</strong>. Heard about the first multi-behavior brain upload, went down the rabbit hole, got the dataset, added the interface, wrapped crypto around it, and shipped it — Cabal style.
            </p>
          </section>

          <section className="section section--links">
            <a href="https://docs.neurosim.fun" target="_blank" rel="noopener noreferrer" className="link">
              Docs
            </a>
            <a href={LORE_ARTICLE} target="_blank" rel="noopener noreferrer" className="link">
              Lore
            </a>
          </section>

          <section className="section section--claim">
            <ClaimFlySection />
          </section>
        </main>

        <footer className="footer">
          <span className="footer__copy">NeuroSim — $NEURO. Launched on the Cabal.</span>
        </footer>
      </div>
    </OnchainProviders>
  );
}

export default App;
