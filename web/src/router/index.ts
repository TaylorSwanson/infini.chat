import { createRouter, createWebHistory } from "vue-router";
import HomeView from "../views/HomeView.vue";

const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	routes: [
		{
			path: "/",
			name: "home",
			component: HomeView,
		},
		// {
		// 	path: "/new",
		// 	name: "newInstance",
		// 	component: () => import("../views/NewRoom.vue"),
		// },
		// {
		// 	path: "/instance/:id",
		// 	name: "instance",
		// 	component: () => import("../views/Instance.vue"),
		// },
	],
});

export default router;
