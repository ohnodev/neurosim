import { OnchainProviders } from './components/OnchainProviders';
import { BrainBackground } from './components/BrainBackground';
import { ClaimFlySection } from './components/ClaimFlySection';
import { ConnectButton } from './components/ConnectButton';
import './App.css';

function App() {
  return (
    <OnchainProviders>
      <div className="app">
        <BrainBackground />
        <header className="header">
          <ConnectButton />
        </header>
        <main className="main">
          <ClaimFlySection />
        </main>
      </div>
    </OnchainProviders>
  );
}

export default App;
