import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ParticipantApp } from "./ParticipantApp";
import { AdminApp } from "./AdminApp";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminApp />} />
        <Route path="/" element={<ParticipantApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
