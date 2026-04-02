import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ParticipantApp } from "./ParticipantApp";
import { AdminApp } from "./AdminApp";
import { ThankYouPage } from "./ThankYouPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminApp />} />
        <Route path="/thankyou" element={<ThankYouPage />} />
        <Route path="/" element={<ParticipantApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
