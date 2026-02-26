import React from 'react'
import { View, Text, Button, StyleSheet } from 'react-native'
import { observer } from 'mobx-react-lite'
import { Tab } from '@/shared/types/browser'

type BookmarkTabProps = {
  tab: Tab
  index: number
  removeTab: (index: number) => void
}

const BookmarkTabs: React.FC<BookmarkTabProps> = observer(({ tab, index, removeTab }) => {
  return (
    <View style={styles.tab}>
      <Text style={styles.title}>{tab.title}</Text>
      <Button title="Close" onPress={() => removeTab(index)} />
    </View>
  )
})

export default BookmarkTabs

const styles = StyleSheet.create({
  tab: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
    backgroundColor: '#1f1f1f'
  },
  title: {
    color: '#fff',
    marginBottom: 8
  }
})
