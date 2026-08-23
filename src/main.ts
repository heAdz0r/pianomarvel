import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { initMotion } from "./motion"; // Кинетический слой: reveal, parallax и scrollspy.

createApp(App).mount("#app");
initMotion(); // CHANGED: навешиваем анимации после монтирования корня
