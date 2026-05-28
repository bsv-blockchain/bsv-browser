import { router } from 'expo-router'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'

export default function NotFound() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Page could not be found.</Text>
      <TouchableOpacity onPress={() => router.replace('/')} style={styles.button}>
        <Text style={styles.buttonText}>Go home</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff'
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    color: '#111'
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#111'
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600'
  }
})
