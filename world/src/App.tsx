import { Navigate, Route, Routes } from 'react-router-dom'
import { OnchainProviders } from './components/OnchainProviders'
import { NotificationProvider } from './contexts/NotificationContext'
import FlyViewer from './components/FlyViewer'
import VisualizationPage from './pages/VisualizationPage'
import HeadingCalibrationPage from './pages/HeadingCalibrationPage'
import './App.css'

function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={(
          <OnchainProviders>
            <FlyViewer />
          </OnchainProviders>
        )}
      />
      <Route path="/visualization" element={<NotificationProvider><VisualizationPage /></NotificationProvider>} />
      <Route path="/heading-calibration" element={<HeadingCalibrationPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
