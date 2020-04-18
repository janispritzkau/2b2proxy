<template>
  <main>
    <h3>Login</h3>
    <input autocomplete="none" type="text" v-model="username" class="input" />
    <input autocomplete="none" type="password" v-model="password" class="input" />
    <button class="button raised primary" @click="login">Login</button>
  </main>
</template>

<script>
export default {
  data() {
    return {
      username: "",
      password: ""
    }
  },
  methods: {
    login() {
      fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.username, password: this.password })
      }).then((res) => alert(res.statusText)).catch(error => alert(error.toString()))
    }
  }
}
</script>

<style scoped>
main {
  max-width: 960px;
  margin: 32px auto;
}

.input {
  margin-bottom: 16px;
}
</style>