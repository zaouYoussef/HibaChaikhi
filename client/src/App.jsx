import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Layout from "./components/Layout.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import AddMedicamentPage from "./pages/AddMedicamentPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import AlertsPage from "./pages/AlertsPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";

function PrivateRoute({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="ajouter" element={<AddMedicamentPage />} />
        <Route path="recherche" element={<SearchPage />} />
        <Route path="historique" element={<HistoryPage />} />
        <Route path="alertes" element={<AlertsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
