import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import DocsLayout from './components/DocsLayout';
import HomePage from './pages/HomePage';
import QuickstartPage from './pages/QuickstartPage';
import ApiPage from './pages/ApiPage';
import ExtendPage from './pages/ExtendPage';
import ExamplesPage from './pages/ExamplesPage';
import PackagesPage from './pages/PackagesPage';

export default function App() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />
      <Routes>
        <Route
          path="/"
          element={
            <DocsLayout>
              <HomePage />
            </DocsLayout>
          }
        />
        <Route
          path="/quickstart"
          element={
            <DocsLayout>
              <QuickstartPage />
            </DocsLayout>
          }
        />
        <Route
          path="/api"
          element={
            <DocsLayout>
              <ApiPage />
            </DocsLayout>
          }
        />
        <Route
          path="/extend"
          element={
            <DocsLayout>
              <ExtendPage />
            </DocsLayout>
          }
        />
        <Route
          path="/examples"
          element={
            <DocsLayout>
              <ExamplesPage />
            </DocsLayout>
          }
        />
        <Route
          path="/packages"
          element={
            <DocsLayout>
              <PackagesPage />
            </DocsLayout>
          }
        />
        <Route
          path="*"
          element={
            <DocsLayout>
              <HomePage />
            </DocsLayout>
          }
        />
      </Routes>
    </div>
  );
}
