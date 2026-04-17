import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ParticipantApp } from "./ParticipantApp";
import { AdminApp } from "./AdminApp";
import { ThankYouPage } from "./ThankYouPage";
import { PostChatSurvey } from "./PostChatSurvey";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/study" element={<ParticipantApp />} />
        <Route path="/study/afterchat" element={<PostChatSurvey />} />
        <Route path="/thankyou" element={<ThankYouPage />} />
        <Route path="/" element={<AdminApp />} />
        <Route path="/admin" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
