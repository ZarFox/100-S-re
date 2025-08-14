import supabase from './SupabaseClient.js';

export function logout() {
    localStorage.removeItem("currentUser");
    localStorage.removeItem("currentUserId");
    sessionStorage.removeItem("currentUser");
    sessionStorage.removeItem("currentUserId");
    localStorage.removeItem("perm");
    window.location.href = "auth.html";
  }

export async function loginUser() {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const stayLoggedIn = document.getElementById("stayLoggedIn").checked;

    if (!username || !password) {
        alert("Remplis tous les champs.");
        return;
    }

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("username", username)
        .eq("password", password)
        .single();

    if (error || !data) {
        alert("Identifiants incorrects.");
        return;
    }

    // ✅ ✅ ✅ AJOUTE CETTE PARTIE ICI
    await supabase
        .from("users")
        .update({ last_login: new Date() })
        .eq("username", username);

    // Enregistre la session
    if (stayLoggedIn) {
        localStorage.setItem("currentUser", username);
        localStorage.setItem("currentUserId", data.id); 
    } else {
        sessionStorage.setItem("currentUser", username);
        sessionStorage.setItem("currentUserId", data.id);
    }

    window.location.href = "index.html";
    window.location.href = "index.html";
}

export async function registerUser() {
    const username = document.getElementById("register-username").value.trim();
    const password = document.getElementById("register-password").value;

    if (!username || !password) {
        alert("Remplis tous les champs.");
        return;
    }

    // Vérifie si l'utilisateur existe déjà
    const { data: existing, error: checkError } = await supabase
        .from("users")
        .select("username")
        .eq("username", username);

    if (existing.length > 0) {
        alert("Ce pseudo est déjà utilisé.");
        return;
    }

    const { error } = await supabase.from("users").insert([{ username, password }]);
    if (error) {
        console.error(error);
        alert("Erreur lors de la création du compte.");
        return;
    }

    alert("Compte créé ! Vous pouvez maintenant vous connecter.");
}

window.loginUser = loginUser;
window.registerUser = registerUser;
window.logout = logout;